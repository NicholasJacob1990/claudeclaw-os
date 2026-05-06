import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronDown, Check } from 'lucide-preact';

// 14 modelos cross-provider — CC-OS local pode usar qualquer um via runtime
// (claude SDK | codex CLI | gemini CLI | openai-sdk | gemini-sdk).
const MODELS = [
  // Claude (SDK · skills/MCPs ~/.claude/)
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  // OpenAI (Codex CLI ou openai-sdk)
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
  { id: 'gpt-4.1', label: 'GPT-4.1' },
  // Gemini (Gemini CLI ou gemini-sdk)
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image' },
  { id: 'gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash Image' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

interface Props {
  value: string;
  onSelect: (model: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function ModelPicker({ value, onSelect, disabled, size = 'sm' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = MODELS.find((m) => m.id === value);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const padCls = size === 'md' ? 'px-2.5 py-1.5 text-[12px]' : 'px-1.5 py-0.5 text-[10px]';

  return (
    <div ref={ref} class="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        class={[
          'inline-flex items-center gap-1 rounded font-medium border transition-colors',
          padCls,
          disabled
            ? 'bg-[var(--color-elevated)] text-[var(--color-text-faint)] border-[var(--color-border)] cursor-not-allowed'
            : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
        ].join(' ')}
      >
        {current?.label || value || 'default'}
        {!disabled && <ChevronDown size={size === 'md' ? 12 : 10} />}
      </button>
      {open && (
        <div
          class="absolute top-full left-0 mt-1 z-30 bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg shadow-2xl overflow-hidden min-w-[140px]"
          onClick={(e) => e.stopPropagation()}
        >
          {MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onSelect(m.id); setOpen(false); }}
              class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--color-elevated)] transition-colors"
            >
              <span class="text-[var(--color-text)]">{m.label}</span>
              {m.id === value && <Check size={12} class="ml-auto text-[var(--color-accent)]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
