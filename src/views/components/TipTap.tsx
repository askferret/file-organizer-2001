"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import React, { useEffect, useCallback } from "react";
import { Mention } from '@tiptap/extension-mention';
import suggestion from './suggestion';

interface TiptapProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
}

const Tiptap: React.FC<TiptapProps> = ({ value, onChange, onKeyDown }) => {
  const handleUpdate = useCallback(
    ({ editor }: { editor: any }) => {
      const content = editor.getText();
      onChange(content);
    },
    [onChange]
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      Mention.configure({
        HTMLAttributes: {
          class: 'mention',
        },
        suggestion,
      }),
    ],
    content: value,
    onUpdate: handleUpdate,
  });

  useEffect(() => {
    if (editor && editor.getText() !== value) {
      editor.commands.setContent(value);
    }
  }, [value, editor]);

  return (
    <div className="tiptap-editor" onKeyDown={onKeyDown}>
      <EditorContent editor={editor} />
    </div>
  );
};

export default Tiptap;