import {
  Plugin,
  Notice,
  TFolder,
  TFile,
  TAbstractFile,
  moment,
  WorkspaceLeaf,
  normalizePath,
  loadPdfJs,
  RequestUrlResponse,
} from "obsidian";
import { logMessage, formatToSafeName } from "../utils";
import { FileOrganizerSettingTab } from "./FileOrganizerSettingTab";
import { ASSISTANT_VIEW_TYPE, AssistantViewWrapper } from "./AssistantView";
import Jimp from "jimp";
import { configureTask, createOpenAIInstance } from "../standalone/models";

import {
  classifyDocumentRouter,
  createNewFolderRouter,
  extractTextFromImageRouter,
  fetchChunksForConceptRouter,
  formatDocumentContentRouter,
  generateAliasVariationsRouter,
  generateDocumentTitleRouter,
  generateRelationshipsRouter,
  generateTagsRouter,
  guessRelevantFolderRouter,
  identifyConceptsAndFetchChunksRouter,
  identifyConceptsRouter,
} from "./aiServiceRouter";

type TagCounts = {
  [key: string]: number;
};

class FileOrganizerSettings {
  API_KEY = "";
  useLogs = true;
  defaultDestinationPath = "_FileOrganizer2000/Processed";
  attachmentsPath = "_FileOrganizer2000/Processed/Attachments";
  pathToWatch = "_FileOrganizer2000/Inbox";
  logFolderPath = "_FileOrganizer2000/Logs";
  useSimilarTags = true; // default value is true
  renameInstructions =
    "Rename the document based on the content. Keep it short and relevant.";

  useAutoAppend = false;
  usePro = true;
  useSimilarTagsInFrontmatter = false;
  // enableEarlyAccess = false;
  // earlyAccessCode = "";
  processedTag = false;
  // new formatting
  templatePaths = "_FileOrganizer2000/Templates";
  // experimental features settings
  enableAliasGeneration = false;
  enableAtomicNotes = false;
  enableSimilarFiles = false;

  enableDocumentClassification = false;

  ignoreFolders = [""];
  stagingFolder = ".fileorganizer2000/staging";

  enableAnthropic = false;
  anthropicApiKey = "";
  anthropicModel = "claude-3-opus-20240229";

  enableOpenAI = true;
  openAIApiKey = "";
  openAIModel = "gpt-4o";
  enableSelfHosting = false;
  enableOllama = false;
  selfHostingURL = "http://localhost:3000/api";
  // ollamaModel = "mistral";

  taggingModel = "gpt-4o";
  foldersModel = "gpt-4o";
  relationshipsModel = "gpt-4o";
  nameModel = "gpt-4o";
  classifyModel = "gpt-4o";
  visionModel = "gpt-4o";
  formatModel = "gpt-4o";
  ollamaModels: string[] = ["codegemma"];
  openAIBaseUrl = "https://api.openai.com/v1";

  userModels: {
    [key: string]: {
      url: string;
      apiKey: string;
      provider: "openai" | "ollama" | "anthropic";
    };
  } = {};
}

const validImageExtensions = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
const validAudioExtensions = [
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "wav",
  "webm",
];
const validMediaExtensions = [...validImageExtensions, ...validAudioExtensions];
const validTextExtensions = ["md", "txt"];

const validExtensions = [
  ...validMediaExtensions,
  ...validTextExtensions,
  "pdf",
];

const isValidExtension = (extension: string) => {
  if (!validExtensions.includes(extension)) {
    new Notice("Sorry, FileOrganizer does not support this file type.");
    return false;
  }
  return true;
};
// determine sever url

// move to utils later
export async function makeApiRequest<T>(
  requestFn: () => Promise<RequestUrlResponse>
): Promise<RequestUrlResponse> {
  const response: RequestUrlResponse = await requestFn();
  console.log("response", response);
  // if response status is in good range return
  if (response.status >= 200 && response.status < 300) {
    return response;
  }
  if (response.json.error) {
    new Notice(`File Organizer error: ${response.json.error}`, 6000);
    throw new Error(response.json.error);
  }

  // if error throw
  throw new Error("Unknown error");
}
export interface FileMetadata {
  instructions: {
    shouldClassify: boolean;
    shouldAppendAlias: boolean;
    shouldAppendSimilarTags: boolean;
  };
  classification?: string;
  originalText: string;
  originalPath: string | undefined;
  originalName: string;
  aiFormattedText: string;
  newName: string;
  newPath: string;
  markAsProcessed: boolean;
  shouldCreateMarkdownContainer: boolean;
  aliases: string[];
  similarTags: string[];
}

export default class FileOrganizer extends Plugin {
  settings: FileOrganizerSettings;

  getServerUrl(): string {
    const serverUrl = this.settings.enableSelfHosting
      ? this.settings.selfHostingURL
      : "https://app.fileorganizer2000.com";

    console.log(`Current server URL: ${serverUrl}`);

    return serverUrl;
  }

  // all files in inbox will go through this function
  async processFileV2(originalFile: TFile, oldPath?: string): Promise<void> {
    try {
      new Notice(`Looking at ${originalFile.basename}`, 3000);

      if (
        !originalFile.extension ||
        !isValidExtension(originalFile.extension)
      ) {
        return;
      }

      await this.checkAndCreateFolders();

      const text = await this.getTextFromFile(originalFile);
      // we trim text to 128k tokens before passing it to the model
      // const trimmedText = await this.trimContentToTokenLimit(text, 128 * 1000);

      const instructions = await this.generateInstructions(originalFile);
      const metadata = await this.generateMetadata(
        originalFile,
        instructions,
        text,
        oldPath
      );
      console.log({ metadata });
      await this.executeInstructions(metadata, originalFile, text);
    } catch (error) {
      new Notice(`Error processing ${originalFile.basename}`, 3000);
      new Notice(error.message, 6000);
      console.error(error);
    }
  }

  async generateInstructions(
    file: TFile
  ): Promise<FileMetadata["instructions"]> {
    const shouldClassify = this.settings.enableDocumentClassification;
    const shouldAppendAlias = this.settings.enableAliasGeneration;
    const shouldAppendSimilarTags = this.settings.useSimilarTags;

    return {
      shouldClassify,
      shouldAppendAlias,
      shouldAppendSimilarTags,
    };
  }

  async generateMetadata(
    file: TFile,
    instructions: FileMetadata["instructions"],
    textToFeedAi: string,
    oldPath?: string
  ): Promise<FileMetadata> {
    const documentName = await this.generateNameFromContent(
      textToFeedAi,
      file.basename
    );

    const classificationResult = instructions.shouldClassify
      ? await this.classifyAndFormatDocumentV2(file, textToFeedAi)
      : null;

    const classification = classificationResult?.type;
    const aiFormattedText = classificationResult?.formattedText || "";

    const newPath = await this.getAIClassifiedFolder(textToFeedAi, file.path);

    const aliases = instructions.shouldAppendAlias
      ? await this.generateAliasses(documentName, textToFeedAi)
      : [];

    const similarTags = instructions.shouldAppendSimilarTags
      ? await this.getSimilarTags(textToFeedAi, documentName)
      : [];

    return {
      instructions,
      classification,
      originalText: textToFeedAi,
      originalPath: oldPath,
      originalName: file.basename,
      aiFormattedText,
      shouldCreateMarkdownContainer:
        validMediaExtensions.includes(file.extension) ||
        file.extension === "pdf",
      markAsProcessed: true,
      newName: documentName,
      newPath,
      aliases,
      similarTags,
    };
  }

  async identifyConceptsAndFetchChunks(content: string) {
    try {
      const result = await identifyConceptsAndFetchChunksRouter(
        content,
        this.settings.usePro,
        this.getServerUrl(),
        this.settings.API_KEY
      );
      return result;
    } catch (error) {
      console.error("Error in identifyConceptsAndFetchChunks:", error);
      new Notice("An error occurred while processing the document.", 6000);
      throw error;
    }
  }

  async retrieveFileToModify(originalFile: TFile, isMedia: boolean) {
    if (isMedia) {
      this.appendToCustomLogFile(`Created markdown find to annotate media`);
      return await this.app.vault.create(
        `${this.settings.defaultDestinationPath}/${originalFile.basename}.md`,
        ""
      );
    }

    return originalFile;
  }

  async executeInstructions(
    metadata: FileMetadata,
    fileBeingProcessed: TFile,
    text: string
  ): Promise<void> {
    // Create a new markdown file in default folder
    const fileToOrganize = await this.retrieveFileToModify(
      fileBeingProcessed,
      metadata.shouldCreateMarkdownContainer
    );

    // If it's a brand new markdown file it should be annotated
    if (metadata.shouldCreateMarkdownContainer) {
      await this.app.vault.modify(fileToOrganize, text);
      this.appendToCustomLogFile(
        `Annotated ${
          metadata.shouldCreateMarkdownContainer ? "media" : "file"
        } [[${metadata.newName}]]`
      );
    }

    // If it should be classified/formatted
    if (metadata.instructions.shouldClassify && metadata.classification) {
      if (
        !metadata.shouldCreateMarkdownContainer ||
        metadata.shouldCreateMarkdownContainer
      ) {
        await this.app.vault.modify(fileToOrganize, metadata.aiFormattedText);
        this.appendToCustomLogFile(
          `Classified [[${metadata.newName}]] as ${metadata.classification} and formatted it with [[${this.settings.templatePaths}/${metadata.classification}]]`
        );
      }
    }

    // append the attachment as a reference to audio, image, or pdf files.
    if (metadata.shouldCreateMarkdownContainer) {
      const mediaFile = fileBeingProcessed;
      await this.moveToAttachmentFolder(mediaFile, metadata.newName);
      this.appendToCustomLogFile(
        `Moved [[${mediaFile.basename}.${mediaFile.extension}]] to attachments folders`
      );
      await this.appendAttachment(fileToOrganize, mediaFile);
      this.appendToCustomLogFile(`Added attachment to [[${metadata.newName}]]`);
    }

    // Move the file to its new location
    await this.moveFile(fileToOrganize, metadata.newName, metadata.newPath);
    this.appendToCustomLogFile(
      `Renamed ${metadata.originalName} to [[${fileToOrganize.basename}]]`
    );
    this.appendToCustomLogFile(
      `Organized [[${fileToOrganize.basename}]] into ${metadata.newPath}`
    );

    // Handle similar tags
    if (
      metadata.instructions.shouldAppendSimilarTags &&
      metadata.similarTags.length > 0
    ) {
      for (const tag of metadata.similarTags) {
        await this.appendTag(fileToOrganize, tag);
      }
      this.appendToCustomLogFile(
        `Appended similar tags to [[${fileToOrganize.basename}]]`
      );
    }
  }

  async trimContentToTokenLimit(
    content: string,
    tokenLimit: number
  ): Promise<string> {
    const encoding = getEncoding("cl100k_base");
    const tokens = encoding.encode(content);
    console.log("tokens", tokens);

    if (tokens.length > tokenLimit) {
      const trimmedTokens = tokens.slice(0, tokenLimit);
      return encoding.decode(trimmedTokens);
    }
    return content;
  }
  updateOpenAIConfig() {
    createOpenAIInstance(
      this.settings.openAIApiKey,
      this.settings.openAIModel,
      this.settings.openAIBaseUrl
    );
  }
  async generateAliasses(name: string, content: string): Promise<string[]> {
    return await generateAliasVariationsRouter(
      name,
      content,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY
    );
  }

  async createMetadataFile(file: TFile, metadata: Record<string, any>) {
    const metadataFolderPath = "_FileOrganizer2000/.metadata";
    await this.ensureFolderExists(metadataFolderPath);

    const metadataFilePath = `${metadataFolderPath}/.${file.basename}.json`;
    const metadataContent = JSON.stringify(metadata, null, 2);

    await this.app.vault.create(metadataFilePath, metadataContent);
  }

  async formatContentV2(
    file: TFile,
    content: string,
    formattingInstruction: string
  ): Promise<string> {
    try {
      const formattedContent = await formatDocumentContentRouter(
        content,
        formattingInstruction,
        this.settings.usePro,
        this.getServerUrl(),
        this.settings.API_KEY
      );
      return formattedContent;
    } catch (error) {
      console.error("Error formatting content:", error); // Added error logging
      new Notice("An error occurred while formatting the content.", 6000); // Added user notice
    }
    return "";
  }
  async classifyAndFormatDocumentV2(file: TFile, content: string) {
    try {
      const classification = await this.classifyContent(content, file.basename);
      if (classification) {
        const formattedText = await this.formatContentV2(
          file,
          content,
          classification.formattingInstruction
        );
        return {
          type: classification.type,
          formattingInstruction: classification.formattingInstruction,
          formattedText,
        };
      }
      return null;
    } catch (error) {
      console.error("Error in classifyAndFormatDocumentV2:", error);
      new Notice(
        "An error occurred while classifying and formatting the document.",
        6000
      );
      return null;
    }
  }

  async formatContent(
    file: TFile,
    content: string,
    formattingInstruction: string
  ): Promise<void> {
    try {
      new Notice("Formatting content...", 3000);

      // Create RAW folder if it doesn't exist
      const rawFolderPath = `${this.settings.defaultDestinationPath}/RAW`;
      await this.ensureFolderExists(rawFolderPath);

      // Generate a unique filename for the RAW file
      const rawFileName = await this.getUniqueFileName(
        `${file.basename}_RAW`,
        file.extension,
        rawFolderPath
      );
      const rawFilePath = `${rawFolderPath}/${rawFileName}`;

      // Copy the original file to the RAW folder
      await this.app.vault.copy(file, rawFilePath);

      let formattedContent = "";
      const updateCallback = async (partialContent: string) => {
        formattedContent = partialContent;
      };

      await this.formatStream(
        content,
        formattingInstruction,
        this.settings.usePro,
        this.getServerUrl(),
        this.settings.API_KEY,
        updateCallback
      );

      // Add link to RAW file at the end of the formatted content
      const encodedRawFilePath = this.encodeObsidianPath(rawFilePath);
      const rawFileLink = `\n\n---\n[Link to original content](${encodedRawFilePath})`;
      formattedContent += rawFileLink;

      // Update the file with the formatted content including the RAW file link
      await this.app.vault.modify(file, formattedContent);

      // Get the TFile object for the RAW file
      const rawFile = this.app.vault.getAbstractFileByPath(rawFilePath);
      if (rawFile instanceof TFile) {
        // Add link to formatted file in the RAW file
        const encodedFormattedFilePath = this.encodeObsidianPath(file.path);
        const formattedFileLink = `\n\n---\n[Link to formatted content](${encodedFormattedFilePath})`;
        await this.app.vault.append(rawFile, formattedFileLink);
      }

      new Notice("Content formatted successfully", 3000);
    } catch (error) {
      console.error("Error formatting content:", error);
      new Notice("An error occurred while formatting the content.", 6000);
    }
  }

  // Add this helper method to your class
  private encodeObsidianPath(path: string): string {
    return path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  // create unique file name when RAW file name already exists
  async getUniqueFileName(
    baseName: string,
    extension: string,
    folderPath: string
  ): Promise<string> {
    let fileName = `${baseName}.${extension}`;
    let counter = 1;
    while (await this.app.vault.adapter.exists(`${folderPath}/${fileName}`)) {
      fileName = `${baseName}_${counter}.${extension}`;
      counter++;
    }
    return fileName;
  }
  async createFileInInbox(content: string): Promise<void> {
    const fileName = `chunk_${Date.now()}.md`;
    const filePath = `${this.settings.pathToWatch}/${fileName}`;
    await this.app.vault.create(filePath, content);
    await this.processFileV2(
      this.app.vault.getAbstractFileByPath(filePath) as TFile
    );
  }

  async identifyConcepts(content: string): Promise<string[]> {
    return await identifyConceptsRouter(
      content,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY
    );
  }

  async fetchChunkForConcept(
    content: string,
    concept: string
  ): Promise<{ content: string }> {
    return await fetchChunksForConceptRouter(
      content,
      concept,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY
    );
  }
  // we use this to keep track if we have already processed a file vs not
  // to indicate it to our users (aka they won't need to send it to inbox again)
  async tagAsProcessed(file: TFile) {
    if (!this.settings.processedTag) {
      return;
    }
    const tag = "#fo2k";
    this.appendTag(file, tag);
  }

  async getClassifications(): Promise<
    { type: string; formattingInstruction: string }[]
  > {
    const templateFolder = this.app.vault.getAbstractFileByPath(
      this.settings.templatePaths
    );

    if (!templateFolder || !(templateFolder instanceof TFolder)) {
      console.error("Template folder not found or is not a valid folder.");
      return [];
    }

    const templateFiles: TFile[] = templateFolder.children.filter(
      (file) => file instanceof TFile
    ) as TFile[];

    const classifications = await Promise.all(
      templateFiles.map(async (file) => ({
        type: file.basename,
        formattingInstruction: await this.app.vault.read(file),
      }))
    );

    return classifications;
  }
  async extractTextFromPDF(file: TFile): Promise<string> {
    const pdfjsLib = await loadPdfJs(); // Ensure PDF.js is loaded
    console.log("extracting text from pdf");
    try {
      const arrayBuffer = await this.app.vault.readBinary(file);
      const bytes = new Uint8Array(arrayBuffer);
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      let text = "";
      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const textContent = await page.getTextContent();
        console.log("textContent", textContent);
        text += textContent.items.map((item) => item.str).join(" ");
      }
      return text;
    } catch (error) {
      console.error(`Error extracting text from PDF: ${error}`);
      return "";
    }
  }
  async formatStream(
    content: string,
    formattingInstruction: string,
    usePro: boolean,
    serverUrl: string,
    apiKey: string,
    updateCallback: (partialContent: string) => void
  ): Promise<string> {
    const response = await fetch(`${serverUrl}/api/format-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        content,
        formattingInstruction,
      }),
    });

    if (!response.ok) {
      throw new Error(`Formatting failed: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let formattedContent = "";

    while (true) {
      const { done, value } = (await reader?.read()) ?? {
        done: true,
        value: undefined,
      };
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      formattedContent += chunk;
      updateCallback(formattedContent);
    }

    return formattedContent;
  }
  async transcribeAudio(
    audioBuffer: ArrayBuffer,
    fileExtension: string,
    {
      usePro,
      serverUrl,
      fileOrganizerApiKey,
      openAIApiKey,
    }: {
      usePro: boolean;
      serverUrl: string;
      fileOrganizerApiKey: string;
      openAIApiKey: string;
    }
  ): Promise<Response> {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: `audio/${fileExtension}` });
    formData.append("audio", blob, `audio.${fileExtension}`);
    formData.append("fileExtension", fileExtension);
    // const newServerUrl = "http://localhost:3001/transcribe";
    const newServerUrl =
      "https://file-organizer-2000-production.up.railway.app/transcribe";
    const response = await fetch(newServerUrl, {
      method: "POST",
      body: formData,
      headers: {
        Authorization: `Bearer ${fileOrganizerApiKey}`,
        // "Content-Type": "multipart/form-data",
      },
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Transcription failed: ${errorData.error}`);
    }
    return response;
  }

  async generateTranscriptFromAudio(
    file: TFile
  ): Promise<AsyncIterableIterator<string>> {
    new Notice(
      `Generating transcription for ${file.basename}. This may take a few minutes.`,
      8000
    );
    try {
      const audioBuffer = await this.app.vault.readBinary(file);
      const response = await this.transcribeAudio(audioBuffer, file.extension, {
        usePro: this.settings.usePro,
        serverUrl: this.getServerUrl(),
        fileOrganizerApiKey: this.settings.API_KEY,
        openAIApiKey: this.settings.openAIApiKey,
      });

      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();

      async function* generateTranscript() {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield new TextDecoder().decode(value);
        }
      }

      new Notice(`Transcription started for ${file.basename}`, 5000);
      return generateTranscript();
    } catch (e) {
      console.error("Error generating transcript", e);
      new Notice("Error generating transcript", 3000);
      throw e;
    }
  }

  async classifyContent(
    content: string,
    name: string
  ): Promise<{ type: string; formattingInstruction: string } | null> {
    const classifications = await this.getClassifications();
    const templateNames = classifications.map((c) => c.type);

    const documentType = await classifyDocumentRouter(
      content,
      name,
      templateNames,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY
    );

    logMessage("documentType", documentType);

    const selectedClassification = classifications.find(
      (c) => c.type.toLowerCase() === documentType.toLowerCase()
    );

    if (selectedClassification) {
      return {
        type: selectedClassification.type,
        formattingInstruction: selectedClassification.formattingInstruction,
      };
    }

    return null;
  }

  /* experimental above until further notice */

  async organizeFile(file: TFile, content: string) {
    const destinationFolder = await this.getAIClassifiedFolder(
      content,
      file.path
    );
    new Notice(`Most similar folder: ${destinationFolder}`, 3000);
    await this.moveFile(file, file.basename, destinationFolder);
  }

  // let's unpack this into processFileV2
  async renameTagAndOrganize(file: TFile, content: string, fileName: string) {
    const destinationFolder = await this.getAIClassifiedFolder(
      content,
      file.path
    );
    new Notice(`Most similar folder: ${destinationFolder}`, 3000);
    await this.appendAlias(file, file.basename);
    await this.moveFile(file, fileName, destinationFolder);
    await this.appendSimilarTags(content, file);
  }

  async showAssistantSidebar() {
    this.app.workspace.detachLeavesOfType(ASSISTANT_VIEW_TYPE);

    await this.app.workspace.getRightLeaf(false).setViewState({
      type: ASSISTANT_VIEW_TYPE,
      active: true,
    });

    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(ASSISTANT_VIEW_TYPE)[0]
    );
  }

  async getTextFromFile(file: TFile): Promise<string> {
    switch (true) {
      case file.extension === "md":
        return await this.app.vault.read(file);
      case file.extension === "pdf": {
        console.log("pdf");
        const pdfContent = await this.extractTextFromPDF(file);
        console.log("content", pdfContent);
        return pdfContent;
      }
      case validImageExtensions.includes(file.extension):
        return await this.generateImageAnnotation(file);
      case validAudioExtensions.includes(file.extension):
        return await this.generateTranscriptFromAudio(file);
      default:
        throw new Error(`Unsupported file type: ${file.extension}`);
    }
  }

  // adds an attachment to a file using the ![[attachment]] syntax
  async appendAttachment(markdownFile: TFile, attachmentFile: TFile) {
    await this.app.vault.append(markdownFile, `![[${attachmentFile.name}]]`);
  }
  async appendToFrontMatter(file: TFile, key: string, value: string) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (!frontmatter.hasOwnProperty(key)) {
        frontmatter[key] = [value];
      } else if (!Array.isArray(frontmatter[key])) {
        frontmatter[key] = [frontmatter[key], value];
      } else {
        frontmatter[key].push(value);
      }
    });
  }

  async appendAlias(file: TFile, alias: string) {
    this.appendToFrontMatter(file, "aliases", alias);
  }

  async moveFile(
    file: TFile,
    humanReadableFileName: string,
    destinationFolder = ""
  ) {
    let destinationPath = `${destinationFolder}/${humanReadableFileName}.${file.extension}`;
    if (await this.app.vault.adapter.exists(normalizePath(destinationPath))) {
      const timestamp = Date.now();
      const timestampedFileName = `${humanReadableFileName}_${timestamp}`;

      await this.appendToCustomLogFile(
        `File [[${humanReadableFileName}]] already exists. Renaming to [[${timestampedFileName}]]`
      );
      destinationPath = `${destinationFolder}/${timestampedFileName}.${file.extension}`;
    }
    await this.ensureFolderExists(destinationFolder);
    await this.app.vault.rename(file, `${destinationPath}`);
    return file;
  }

  async getSimilarFiles(fileToCheck: TFile): Promise<string[]> {
    if (!fileToCheck) {
      return [];
    }

    const activeFileContent = await this.app.vault.read(fileToCheck);
    logMessage("activeFileContent", activeFileContent);
    const settingsPaths = [
      this.settings.pathToWatch,
      this.settings.defaultDestinationPath,
      this.settings.attachmentsPath,
      this.settings.logFolderPath,
      this.settings.templatePaths,
    ];
    const allFiles = this.app.vault.getMarkdownFiles();
    // remove any file path that is part of the settingsPath
    const allFilesFiltered = allFiles.filter(
      (file) =>
        !settingsPaths.some((path) => file.path.includes(path)) &&
        file.path !== fileToCheck.path
    );

    const fileContents = allFilesFiltered.map((file) => ({
      name: file.path,
    }));

    const similarFiles = await generateRelationshipsRouter(
      activeFileContent,
      fileContents,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY
    );

    return similarFiles.filter(
      (file: string) =>
        !settingsPaths.some((path) => file.includes(path)) &&
        !this.settings.ignoreFolders.includes(file)
    );
  }

  async moveToAttachmentFolder(file: TFile, newFileName: string) {
    const destinationFolder = this.settings.attachmentsPath;
    return await this.moveFile(file, newFileName, destinationFolder);
  }

  async generateNameFromContent(
    content: string,
    currentName: string
  ): Promise<string> {
    const renameInstructions = this.settings.renameInstructions;
    logMessage("renameInstructions", renameInstructions);
    const name = await generateDocumentTitleRouter(
      content,
      currentName,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY,
      renameInstructions
    );
    return formatToSafeName(name);
  }

  async compressImage(fileContent: Buffer): Promise<Buffer> {
    const image = await Jimp.read(fileContent);

    // Check if the image is bigger than 1000 pixels in either width or height
    if (image.getWidth() > 1000 || image.getHeight() > 1000) {
      // Resize the image to a maximum of 1000x1000 while preserving aspect ratio
      image.scaleToFit(1000, 1000);
    }

    const resizedImage = await image.getBufferAsync(Jimp.MIME_PNG);
    return resizedImage;
  }

  isWebP(fileContent: Buffer): boolean {
    // Check if the file starts with the WebP signature
    return (
      fileContent.slice(0, 4).toString("hex") === "52494646" &&
      fileContent.slice(8, 12).toString("hex") === "57454250"
    );
  }

  // main.ts
  async generateImageAnnotation(file: TFile, customPrompt?: string) {
    new Notice(
      `Generating annotation for ${file.basename} this can take up to a minute`,
      8000
    );

    const arrayBuffer = await this.app.vault.readBinary(file);
    const fileContent = Buffer.from(arrayBuffer);
    const imageSize = fileContent.byteLength;
    const imageSizeInMB2 = imageSize / (1024 * 1024);
    logMessage(`Image size: ${imageSizeInMB2.toFixed(2)} MB`);

    let processedArrayBuffer: ArrayBuffer;

    if (!this.isWebP(fileContent)) {
      // Compress the image if it's not a WebP
      const resizedImage = await this.compressImage(fileContent);
      processedArrayBuffer = resizedImage.buffer;
    } else {
      // If it's a WebP, use the original file content directly
      processedArrayBuffer = arrayBuffer;
    }

    const processedContent = await extractTextFromImageRouter(
      processedArrayBuffer,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY
    );

    return processedContent;
  }
  async ensureFolderExists(folderPath: string) {
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  async checkAndCreateFolders() {
    this.ensureFolderExists(this.settings.pathToWatch);
    this.ensureFolderExists(this.settings.defaultDestinationPath);
    this.ensureFolderExists(this.settings.attachmentsPath);
    this.ensureFolderExists(this.settings.logFolderPath);
    this.ensureFolderExists(this.settings.templatePaths);
    // used to store info about changes
    this.ensureFolderExists(this.settings.stagingFolder);
  }
  async checkAndCreateTemplates() {
    // add template
    const meetingNoteTemplatePath = `${this.settings.templatePaths}/meeting_note.md`;

    if (!(await this.app.vault.adapter.exists(meetingNoteTemplatePath))) {
      await this.app.vault.create(
        meetingNoteTemplatePath,
        `# Meeting Note Template

## Meeting Details
- Date: {{date}} in format YYYY-MM-DD
- Participants: 

## Audio Reference
![[{{audio_file}}]]

## Key Points
[Summarize the main points discussed in the meeting]

## Action Items
- [ ] Action item 1
- [ ] Action item 2

## Notes
[Add your meeting notes here]

## Transcription
[Insert the full transcription below]

---

AI Instructions:
1. Merge the transcription into the content, focusing on key points and action items.
2. Summarize the main discussion points in the "Key Points" section.
3. Extract and list any action items or tasks in the "Action Items" section.
4. Preserve the reference to the original audio file.
5. Keep the full transcription at the bottom of the note for reference.
6. Maintain the overall structure of the note, including headers and sections.
`
      );
    }
  }

  async getBacklog() {
    const allFiles = this.app.vault.getFiles();
    const pendingFiles = allFiles.filter((file) =>
      file.path.includes(this.settings.pathToWatch)
    );
    return pendingFiles;
  }
  async processBacklog() {
    const pendingFiles = await this.getBacklog();
    for (const file of pendingFiles) {
      await this.processFileV2(file);
    }
  }
  async getSimilarTags(content: string, fileName: string): Promise<string[]> {
    const tags: string[] = await this.getAllTags();

    if (tags.length === 0) {
      console.log("No tags found");
      return [];
    }

    return await generateTagsRouter(
      content,
      fileName,
      tags,
      this.settings.usePro,
      this.getServerUrl(),
      this.settings.API_KEY
    );
  }

  async getAllTags(): Promise<string[]> {
    // Fetch all tags from the vault
    // @ts-ignore
    const tags: TagCounts = this.app.metadataCache.getTags();

    // If no tags are found, return an empty array
    if (Object.keys(tags).length === 0) {
      logMessage("No tags found");
      return [];
    }

    // Sort tags by their occurrence count in descending order
    const sortedTags = Object.entries(tags).sort((a, b) => b[1] - a[1]);

    // Return the list of sorted tags
    return sortedTags.map((tag) => tag[0]);
  }

  isTFolder(file: TAbstractFile): file is TFolder {
    return file instanceof TFolder;
  }

  getAllFolders(): string[] {
    const allFiles = this.app.vault.getAllLoadedFiles();
    const folderPaths = allFiles
      .filter((file) => this.isTFolder(file))
      .map((folder) => folder.path);

    const uniqueFolders = [...new Set(folderPaths)];
    // logMessage("uniqueFolders", uniqueFolders);
    return uniqueFolders;
  }

  async getAIClassifiedFolder(
    content: string,
    filePath: string
  ): Promise<string> {
    let destinationFolder = "None";

    const uniqueFolders = await this.getAllFolders();
    logMessage("uniqueFolders", uniqueFolders);

    logMessage("ignore folders", this.settings.ignoreFolders);

    const filteredFolders = uniqueFolders
      .filter((folder) => folder !== filePath)
      .filter((folder) => folder !== this.settings.defaultDestinationPath)
      .filter((folder) => folder !== this.settings.attachmentsPath)
      .filter((folder) => folder !== this.settings.logFolderPath)
      .filter((folder) => folder !== this.settings.pathToWatch)
      .filter((folder) => folder !== this.settings.templatePaths)
      .filter((folder) => !folder.includes("_FileOrganizer2000"))
      // if  this.settings.ignoreFolders has one or more folder specified, filter them out including subfolders
      .filter((folder) => {
        const hasIgnoreFolders =
          this.settings.ignoreFolders.length > 0 &&
          this.settings.ignoreFolders[0] !== "";
        if (!hasIgnoreFolders) return true;
        const isFolderIgnored = this.settings.ignoreFolders.some(
          (ignoreFolder) => folder.startsWith(ignoreFolder)
        );
        return !isFolderIgnored;
      })
      .filter((folder) => folder !== "/");
    logMessage("filteredFolders", filteredFolders);
    const guessedFolder = await guessRelevantFolderRouter(
      content,
      filePath,
      filteredFolders,
      this.getServerUrl(),
      this.settings.API_KEY
    );

    if (guessedFolder === null || guessedFolder === "null") {
      logMessage("no good folder, creating a new one instead");
      const newFolderName = await createNewFolderRouter(
        content,
        filePath,
        filteredFolders,
        this.settings.usePro,
        this.getServerUrl(),
        this.settings.API_KEY
      );
      destinationFolder = newFolderName;
    } else {
      destinationFolder = guessedFolder;
    }
    return destinationFolder;
  }

  async appendTag(file: TFile, tag: string) {
    // Ensure the tag starts with a hash symbol
    const formattedTag = tag.startsWith("#") ? tag : `#${tag}`;

    // Append similar tags
    if (this.settings.useSimilarTagsInFrontmatter) {
      await this.appendToFrontMatter(file, "tags", formattedTag);
      return;
    }
    await this.app.vault.append(file, `\n${formattedTag}`);
  }

  async appendSimilarTags(content: string, file: TFile) {
    // Get similar tags
    const similarTags = await this.getSimilarTags(content, file.basename);

    if (similarTags.length === 0) {
      new Notice(`No similar tags found`, 3000);
      return;
    }
    similarTags.forEach(async (tag) => {
      await this.appendTag(file, tag);
    });

    await this.appendToCustomLogFile(
      `Added similar tags to [[${file.basename}]]`
    );
    new Notice(`Added similar tags to ${file.basename}`, 3000);
    return;
  }

  async appendToCustomLogFile(contentToAppend: string, action = "") {
    if (!this.settings.useLogs) {
      return;
    }
    const now = new Date();
    const formattedDate = moment(now).format("YYYY-MM-DD");
    const logFilePath = `${this.settings.logFolderPath}/${formattedDate}.md`;
    // if does not exist create it
    if (!(await this.app.vault.adapter.exists(normalizePath(logFilePath)))) {
      await this.app.vault.create(logFilePath, "");
    }

    const logFile = this.app.vault.getAbstractFileByPath(logFilePath);
    if (!(logFile instanceof TFile)) {
      throw new Error(`File with path ${logFilePath} is not a markdown file`);
    }

    const formattedTime =
      now.getHours().toString().padStart(2, "0") +
      ":" +
      now.getMinutes().toString().padStart(2, "0");
    const contentWithLink = `\n - ${formattedTime} ${contentToAppend}`;
    await this.app.vault.append(logFile, contentWithLink);
  }

  validateAPIKey() {
    if (!this.settings.usePro) {
      // atm we assume no api auth for self hosted
      return true;
    }

    if (!this.settings.API_KEY) {
      throw new Error(
        "Please enter your API Key in the settings of the FileOrganizer plugin."
      );
    }
  }

  initalizeModels() {
    this.updateOpenAIConfig();
    createOpenAIInstance(
      this.settings.openAIApiKey,
      this.settings.openAIModel || "gpt-4o",
      this.settings.openAIBaseUrl
    );

    // Configure tasks with default models
    configureTask("tagging", this.settings.taggingModel || "gpt-4o");
    configureTask("folders", this.settings.foldersModel || "gpt-4o");
    configureTask(
      "relationships",
      this.settings.relationshipsModel || "gpt-4o"
    );
    configureTask("name", this.settings.nameModel || "gpt-4o");
    configureTask("classify", this.settings.classifyModel || "gpt-4o");
    configureTask("vision", this.settings.visionModel || "gpt-4o");
    configureTask("format", this.settings.formatModel || "gpt-4o");
  }

  async onload() {
    await this.initializePlugin();

    this.addRibbonIcon("sparkle", "Fo2k Assistant View", () => {
      this.showAssistantSidebar();
    });

    // on layout ready register event handlers
    this.addCommand({
      id: "append-existing-tags",
      name: "Append existing tags",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          const fileContent = await this.getTextFromFile(activeFile);
          await this.appendSimilarTags(fileContent, activeFile);
        }
      },
    });

    this.addCommand({
      id: "show-assistant",
      name: "Show Assistant",
      callback: async () => {
        await this.showAssistantSidebar();
      },
    });

    this.addCommand({
      id: "add-to-inbox",
      name: "Put in inbox",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          await this.processFileV2(activeFile);
        }
      },
    });

    this.addCommand({
      id: "organize-text-file",
      name: "Organize text file",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          const fileContent = await this.getTextFromFile(activeFile);
          await this.organizeFile(activeFile, fileContent);
        }
      },
    });

    console.log("FileOrganizer2000 loaded");
    console.log("Settings", this.settings);
    this.app.workspace.onLayoutReady(this.registerEventHandlers.bind(this));
    this.processBacklog();
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      new FileOrganizerSettings(),
      await this.loadData()
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  async initializePlugin() {
    await this.loadSettings();
    await this.checkAndCreateFolders();
    await this.checkAndCreateTemplates();
    this.addSettingTab(new FileOrganizerSettingTab(this.app, this));
    this.registerView(
      ASSISTANT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new AssistantViewWrapper(leaf, this)
    );
  }

  async appendTranscriptToActiveFile(
    parentFile: TFile,
    audioFileName: string,
    transcriptIterator: AsyncIterableIterator<string>
  ) {
    const transcriptHeader = `\n\n## Transcript for ${audioFileName}\n\n`;
    await this.app.vault.append(parentFile, transcriptHeader);

    for await (const chunk of transcriptIterator) {
      await this.app.vault.append(parentFile, chunk);
      // Optionally, update UI or perform actions with each chunk
    }

    new Notice(`Transcription completed for ${audioFileName}`, 5000);
  }
  registerEventHandlers() {
    // inbox event
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        console.log("file created", file);
        console.log("path to watch", this.settings.pathToWatch);
        if (!file.path.includes(this.settings.pathToWatch)) return;
        if (file instanceof TFile) {
          this.processFileV2(file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        console.log("file created", file);
        console.log("path to watch", this.settings.pathToWatch);
        if (!file.path.includes(this.settings.pathToWatch)) return;
        if (file instanceof TFile) {
          this.processFileV2(file, oldPath);
        }
      })
    );
  }
}
