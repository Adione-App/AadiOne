/**
 * The Legal & Policies document editor: one page to type into, like a word
 * processor — style menu (Normal text, Heading 1–3), bold, italic,
 * underline, bullet and numbered lists, links, undo / redo. Copy and paste
 * from Word or Google Docs keeps only what a policy can hold.
 *
 * Built on Tiptap (ProseMirror). Its schema is cut down to exactly what a
 * stored page can hold (lib/policyDocument.ts), so the editor can never show
 * something that saving would lose:
 *   - headings hold plain text (no bold or links inside a heading);
 *   - a list point is one paragraph, lists do not nest, numbering starts at 1;
 *   - links are only web addresses, email addresses and phone numbers
 *     (shared infoLinkHref), never opened by a click while editing;
 *   - no code, quotes, strike-through, rules or images.
 *
 * {{PLACEHOLDERS}} and «TO CONFIRM» notes are highlighted where they are.
 *
 * Loaded on its own (React.lazy from pages/InfoPages.tsx), so the editor's
 * code is only downloaded by admins who open a policy.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Heading from '@tiptap/extension-heading';
import { ListItem, OrderedList } from '@tiptap/extension-list';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import { infoLinkHref } from '@shared';
import type { DocNode } from '@/lib/policyDocument';

export interface PolicyEditorHandle {
  /** The document as it is now (call when saving or previewing). */
  getDoc: () => DocNode;
  /** Types text at the cursor (e.g. a {{PLACEHOLDER}}). */
  insertText: (text: string) => void;
}

interface Props {
  /** The document to show; shown again whenever `resetKey` changes. */
  initialDoc: DocNode;
  resetKey: number;
  editable: boolean;
  /** Called on every change (cheap: read the document with getDoc when needed). */
  onChange: () => void;
}

/* -------------------------------------------------------------------------- */
/* Schema: only what a policy can store                                        */
/* -------------------------------------------------------------------------- */

/** Headings hold plain text only. */
const PolicyHeading = Heading.extend({ content: 'text*', marks: '' }).configure({ levels: [1, 2, 3] });
/** One paragraph per point, no nested lists. */
const PolicyListItem = ListItem.extend({ content: 'paragraph' });
/** Numbering always starts at 1, as published pages number it. */
const PolicyOrderedList = OrderedList.extend({
  addAttributes() {
    return { ...this.parent?.(), start: { default: 1, parseHTML: () => 1, renderHTML: () => ({}) } };
  },
});

const highlightKey = new PluginKey<DecorationSet>('policyHighlights');
const TOKEN = /\{\{[A-Z_]+\}\}/g;
const UNCONFIRMED = /«TO CONFIRM[^»]*»?/g;

function highlights(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? '';
    for (const match of text.matchAll(TOKEN)) {
      decorations.push(Decoration.inline(pos + match.index, pos + match.index + match[0].length, { class: 'policy-token' }));
    }
    for (const match of text.matchAll(UNCONFIRMED)) {
      decorations.push(Decoration.inline(pos + match.index, pos + match.index + match[0].length, { class: 'policy-unconfirmed' }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Highlights {{PLACEHOLDERS}} and «TO CONFIRM» notes. */
const PolicyHighlights = Extension.create({
  name: 'policyHighlights',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: (_config, state) => highlights(state.doc),
          apply: (tr, previous) => (tr.docChanged ? highlights(tr.doc) : previous),
        },
        props: { decorations: (state) => highlightKey.getState(state) },
      }),
    ];
  },
});

const EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    listItem: false,
    orderedList: false,
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    link: {
      openOnClick: false,
      // Readers already make typed addresses tappable; a link is only what the admin adds.
      autolink: false,
      linkOnPaste: true,
      defaultProtocol: 'https',
      protocols: ['mailto', 'tel'],
      isAllowedUri: (url: string) => infoLinkHref(url) !== null,
      HTMLAttributes: { rel: 'noopener noreferrer', target: null },
    },
  }),
  PolicyHeading,
  PolicyListItem,
  PolicyOrderedList,
  PolicyHighlights,
];

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                     */
/* -------------------------------------------------------------------------- */

type Style = 'p' | '1' | '2' | '3';

function setStyle(editor: Editor, style: Style) {
  let chain = editor.chain().focus();
  // A list point is a paragraph: leave the list before making it a heading.
  if (style !== 'p' && editor.isActive('listItem')) chain = chain.liftListItem('listItem');
  if (style === 'p') chain.setParagraph().run();
  else chain.setHeading({ level: Number(style) as 1 | 2 | 3 }).run();
}

function toggleList(editor: Editor, kind: 'bullet' | 'numbered') {
  let chain = editor.chain().focus();
  if (editor.isActive('heading')) chain = chain.setParagraph();
  if (kind === 'bullet') chain.toggleBulletList().run();
  else chain.toggleOrderedList().run();
}

function ToolButton({
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      // Keep the text selection in the document while clicking.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-gray-700 transition hover:bg-gray-100 disabled:opacity-35 disabled:hover:bg-transparent ${
        active ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200' : ''
      }`}
    >
      {children}
    </button>
  );
}

const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICONS = {
  bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbered: 'M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.8 13.5a1.4 1.4 0 0 1 2.6.7c0 1-2.6 2-2.6 2.8h2.7M3.8 18.5h2.6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (letter: string) => `${isMac ? '⌘' : 'Ctrl+'}${letter}`;

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      style: (e.isActive('heading', { level: 1 }) ? '1' : e.isActive('heading', { level: 2 }) ? '2' : e.isActive('heading', { level: 3 }) ? '3' : 'p') as Style,
      inHeading: e.isActive('heading'),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      bullets: e.isActive('bulletList'),
      numbered: e.isActive('orderedList'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const divider = <span className="mx-1 hidden h-6 w-px bg-gray-200 sm:block" aria-hidden="true" />;
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5">
      <label className="sr-only" htmlFor="policy-style">
        Text style
      </label>
      <select
        id="policy-style"
        value={state.style}
        onChange={(event) => setStyle(editor, event.target.value as Style)}
        className="h-10 rounded-lg border border-gray-200 bg-white px-2 text-sm font-medium text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      >
        <option value="p">Normal text</option>
        <option value="1">Heading 1 (section)</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
      </select>
      {divider}
      <ToolButton label="Bold" shortcut={key('B')} active={state.bold} disabled={state.inHeading} onClick={() => editor.chain().focus().toggleBold().run()}>
        <span className="text-base font-bold">B</span>
      </ToolButton>
      <ToolButton label="Italic" shortcut={key('I')} active={state.italic} disabled={state.inHeading} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <span className="font-serif text-base italic">I</span>
      </ToolButton>
      <ToolButton label="Underline" shortcut={key('U')} active={state.underline} disabled={state.inHeading} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <span className="text-base underline underline-offset-2">U</span>
      </ToolButton>
      {divider}
      <ToolButton label="Bullet list" active={state.bullets} onClick={() => toggleList(editor, 'bullet')}>
        <Svg d={ICONS.bullets} />
      </ToolButton>
      <ToolButton label="Numbered list" active={state.numbered} onClick={() => toggleList(editor, 'numbered')}>
        <Svg d={ICONS.numbered} />
      </ToolButton>
      <ToolButton label={state.link ? 'Edit link' : 'Add link'} shortcut={key('K')} active={state.link} disabled={state.inHeading} onClick={onLink}>
        <Svg d={ICONS.link} />
      </ToolButton>
      {divider}
      <ToolButton label="Undo" shortcut={key('Z')} disabled={!state.canUndo} onClick={() => editor.chain().focus().undo().run()}>
        <Svg d={ICONS.undo} />
      </ToolButton>
      <ToolButton label="Redo" shortcut={isMac ? '⌘⇧Z' : 'Ctrl+Y'} disabled={!state.canRedo} onClick={() => editor.chain().focus().redo().run()}>
        <Svg d={ICONS.redo} />
      </ToolButton>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Link bar                                                                    */
/* -------------------------------------------------------------------------- */

function LinkBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const existing = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
  const [value, setValue] = useState(existing.replace(/^mailto:|^tel:/, ''));
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const apply = () => {
    const href = infoLinkHref(value);
    if (!href) {
      setError('Enter a web address (like adione.in), an email address or a phone number.');
      return;
    }
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive('link')) {
      // Nothing selected: the address itself becomes the linked text.
      editor.chain().focus().insertContent({ type: 'text', text: value.trim(), marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    onClose();
  };
  const remove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onClose();
  };

  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 p-2.5">
      <label htmlFor="policy-link" className="mb-1 block text-xs font-medium text-gray-600">
        Link to a web address, email or phone number
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="policy-link"
          ref={input}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              apply();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              editor.commands.focus();
              onClose();
            }
          }}
          placeholder="adione.in, support@adione.in or +91 90000 00000"
          inputMode="url"
          autoComplete="off"
          className="h-10 min-w-0 flex-1 basis-56 rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        <button type="button" onClick={apply} className="h-10 rounded-lg bg-brand-500 px-4 text-sm font-semibold text-white hover:bg-brand-600">
          {existing ? 'Update' : 'Add link'}
        </button>
        {existing ? (
          <button type="button" onClick={remove} className="h-10 rounded-lg px-3 text-sm font-semibold text-gray-700 hover:bg-gray-200">
            Remove link
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            editor.commands.focus();
            onClose();
          }}
          className="h-10 rounded-lg px-3 text-sm font-semibold text-gray-500 hover:bg-gray-200"
        >
          Cancel
        </button>
      </div>
      {error ? <p className="mt-1.5 text-xs font-medium text-danger-500">{error}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */

const PolicyDocumentEditor = forwardRef<PolicyEditorHandle, Props>(function PolicyDocumentEditor({ initialDoc, resetKey, editable, onChange }, ref) {
  const [linkOpen, setLinkOpen] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const openLinkRef = useRef<() => void>(() => undefined);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: initialDoc,
    editable,
    shouldRerenderOnTransaction: false,
    onUpdate: () => onChangeRef.current(),
    editorProps: {
      attributes: {
        class: 'policy-doc',
        'aria-label': 'Policy text',
        'aria-multiline': 'true',
        role: 'textbox',
      },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          openLinkRef.current();
          return true;
        }
        return false;
      },
    },
  });

  openLinkRef.current = () => {
    if (editor && editor.isEditable && !editor.isActive('heading')) setLinkOpen(true);
  };

  // A new document from the server (restored, discarded, published): show it —
  // once per `resetKey`, and only on a live editor (React may run effects twice
  // in development, and the editor may be mid-teardown).
  const appliedKey = useRef(resetKey);
  useEffect(() => {
    if (!editor || editor.isDestroyed || appliedKey.current === resetKey) return;
    appliedKey.current = resetKey;
    editor.commands.setContent(initialDoc, { emitUpdate: false });
    setLinkOpen(false);
  }, [editor, resetKey, initialDoc]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(editable);
  }, [editor, editable]);

  useImperativeHandle(
    ref,
    () => ({
      getDoc: () => (editor ? (editor.getJSON() as DocNode) : initialDoc),
      insertText: (text: string) => {
        editor?.chain().focus().insertContent(text).run();
      },
    }),
    [editor, initialDoc],
  );

  if (!editor) return null;
  return (
    <div>
      {editable ? (
        // Stays in view under the panel's header while a long policy scrolls.
        <div className="sticky top-[4.6rem] z-20 -mx-4 border-b border-gray-200 bg-white/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
          <Toolbar editor={editor} onLink={() => openLinkRef.current()} />
          {linkOpen ? <LinkBar editor={editor} onClose={() => setLinkOpen(false)} /> : null}
        </div>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
});

export default PolicyDocumentEditor;
