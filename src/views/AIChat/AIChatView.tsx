import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { createRoot, Root } from 'react-dom/client';
import React from 'react';
import AIChatSidebar from './AIChatSidebar';
import FileOrganizer from '../..';

export class AIChatView extends ItemView {
  private root: Root;
  private plugin: FileOrganizer;

  constructor(leaf: WorkspaceLeaf, plugin: FileOrganizer) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return 'ai-chat-view';
  }

  getDisplayText(): string {
    return 'AI Chat';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    this.root = createRoot(container);
    this.root.render(
      <AIChatSidebar 
        plugin={this.plugin} 
        activeFile={this.app.workspace.getActiveFile()} 
      />
    );
  }

  async onClose(): Promise<void> {
    this.root.unmount();
  }
}