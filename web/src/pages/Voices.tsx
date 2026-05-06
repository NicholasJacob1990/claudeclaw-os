import { useEffect, useState } from 'preact/hooks';
import { Save, Zap } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { AgentAvatar } from '@/components/AgentAvatar';
import { apiGet, apiPost } from '@/lib/api';

interface VoiceRow {
  agent: string;
  audio_provider: string;
  gemini_voice: string;
  xai_voice: string;
  elevenlabs_voice_id: string;
  voxtral_voice_id: string;
  voxtral_ref_audio_path: string;
  groq_voice: string;
  voice_id: string;
  name: string;
  is_default: boolean;
}
interface CatalogEntry { name: string; style: string; }
interface ProviderState { ok: boolean; provider: string | null; }
interface LanguageState { ok: boolean; language: string | null; }
type VoiceField = 'audio_provider' | 'gemini_voice' | 'xai_voice' | 'elevenlabs_voice_id' | 'voxtral_voice_id' | 'voxtral_ref_audio_path' | 'groq_voice';

const INPUT_CLASS = 'w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';

const PROVIDERS = [
  { value: '', label: 'Default (env)' },
  { value: 'gemini-live', label: 'Gemini 3.1 Live' },
  { value: 'gemini-live-25', label: 'Gemini 2.5 Native' },
  { value: 'xai', label: 'Grok Voice (xAI)' },
  { value: 'groq', label: 'Groq PlayAI' },
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'voxtral', label: 'Voxtral / Mistral' },
  { value: 'mixed', label: 'Mixed per-agent TTS' },
  { value: 'cartesia', label: 'Cartesia legacy' },
];

const PER_AGENT_AUDIO_PROVIDERS = [
  { value: '', label: 'Stack default' },
  { value: 'xai', label: 'Grok/xAI' },
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'voxtral', label: 'Voxtral' },
  { value: 'groq', label: 'Groq PlayAI' },
];

const LANGUAGES = [
  { value: 'auto', label: 'Auto multilingual' },
  { value: '', label: 'Off / provider default' },
  { value: 'pt-BR', label: 'Portugues Brasil' },
  { value: 'pt-PT', label: 'Portugues Portugal' },
  { value: 'en-US', label: 'English US' },
  { value: 'en-GB', label: 'English UK' },
  { value: 'es-ES', label: 'Espanol' },
  { value: 'fr-FR', label: 'Francais' },
  { value: 'de-DE', label: 'Deutsch' },
];

export function Voices() {
  return (
    <div class="flex flex-col h-full">
      <PageHeader title="Voices" />
      <VoicesPane />
    </div>
  );
}

interface VoicesPaneProps {
  embedded?: boolean;
}

export function VoicesPane({ embedded }: VoicesPaneProps) {
  const [rows, setRows] = useState<VoiceRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [xaiCatalog, setXaiCatalog] = useState<CatalogEntry[]>([]);
  const [groqCatalog, setGroqCatalog] = useState<CatalogEntry[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Partial<VoiceRow>>>({});
  const [provider, setProvider] = useState('');
  const [language, setLanguage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [stackSaving, setStackSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      const [voiceData, providerData, languageData] = await Promise.all([
        apiGet<{ ok: boolean; voices: VoiceRow[]; gemini_catalog: CatalogEntry[]; xai_catalog: CatalogEntry[]; groq_catalog: CatalogEntry[]; error?: string }>('/api/warroom/voices'),
        apiGet<ProviderState>('/api/warroom/provider'),
        apiGet<LanguageState>('/api/warroom/language'),
      ]);
      if (!voiceData.ok) throw new Error(voiceData.error || 'Failed to load voices');
      setRows(voiceData.voices);
      setCatalog(voiceData.gemini_catalog);
      setXaiCatalog(voiceData.xai_catalog || []);
      setGroqCatalog(voiceData.groq_catalog || []);
      setProvider(providerData.provider || '');
      setLanguage(languageData.language || '');
      setEdits({});
      setDirty(new Set());
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function mergedRow(agent: string, override?: Partial<VoiceRow>): Partial<VoiceRow> {
    const original = rows.find((r) => r.agent === agent) || {};
    return { ...original, ...(edits[agent] || {}), ...(override || {}) };
  }

  function rowChanged(agent: string, candidate: Partial<VoiceRow>): boolean {
    const original = rows.find((r) => r.agent === agent);
    if (!original) return false;
    return (
      (candidate.audio_provider || '') !== (original.audio_provider || '') ||
      candidate.gemini_voice !== original.gemini_voice ||
      candidate.xai_voice !== original.xai_voice ||
      (candidate.elevenlabs_voice_id || '') !== (original.elevenlabs_voice_id || '') ||
      (candidate.voxtral_voice_id || '') !== (original.voxtral_voice_id || '') ||
      (candidate.voxtral_ref_audio_path || '') !== (original.voxtral_ref_audio_path || '') ||
      (candidate.groq_voice || '') !== (original.groq_voice || '')
    );
  }

  function changeField(agent: string, field: VoiceField, value: string) {
    const nextRow = mergedRow(agent, { [field]: value } as Partial<VoiceRow>);
    setEdits((prev) => ({ ...prev, [agent]: { ...(prev[agent] || {}), [field]: value } }));
    setDirty((prev) => {
      const next = new Set(prev);
      if (rowChanged(agent, nextRow)) next.add(agent); else next.delete(agent);
      return next;
    });
    setStatus(null);
  }

  async function save(thenApply: boolean) {
    if (dirty.size === 0) return;
    setSaving(true);
    setStatus(null);
    try {
      const updates = Array.from(dirty).map((agent) => {
        const row = mergedRow(agent);
        return {
          agent,
          audio_provider: row.audio_provider || '',
          gemini_voice: row.gemini_voice,
          xai_voice: row.xai_voice,
          elevenlabs_voice_id: row.elevenlabs_voice_id || '',
          voxtral_voice_id: row.voxtral_voice_id || '',
          voxtral_ref_audio_path: row.voxtral_ref_audio_path || '',
          groq_voice: row.groq_voice || '',
        };
      });
      const res = await apiPost<{ ok: boolean; error?: string }>('/api/warroom/voices', { updates });
      if (!res.ok) throw new Error(res.error || 'Save failed');
      setStatus('Saved.');
      await load();
      if (thenApply) await apply();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    setApplying(true);
    setStatus('Applying - bouncing voice subprocess...');
    try {
      const res = await apiPost<{ ok: boolean; killed_pids?: number[]; error?: string }>('/api/warroom/voices/apply');
      if (!res.ok) throw new Error(res.error || 'Apply failed');
      setStatus(`Applied. Bounced ${res.killed_pids?.length || 0} subprocess(es).`);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setApplying(false);
    }
  }

  async function setAudioStack(nextProvider: string) {
    setStackSaving(true);
    setStatus('Applying audio stack...');
    try {
      const res = await apiPost<{ ok: boolean; error?: string }>('/api/warroom/provider', { provider: nextProvider || null, restart: true });
      if (!res.ok) throw new Error(res.error || 'Provider update failed');
      setProvider(nextProvider);
      setStatus('Audio stack applied.');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setStackSaving(false);
    }
  }

  async function setOutputLanguage(nextLanguage: string) {
    setStackSaving(true);
    setStatus('Applying language...');
    try {
      const res = await apiPost<{ ok: boolean; error?: string }>('/api/warroom/language', { language: nextLanguage || null, restart: true });
      if (!res.ok) throw new Error(res.error || 'Language update failed');
      setLanguage(nextLanguage);
      setStatus('Language applied.');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setStackSaving(false);
    }
  }

  function effective(agent: string, field: VoiceField): string {
    const value = (mergedRow(agent) as any)[field];
    return typeof value === 'string' ? value : '';
  }

  return (
    <>
      <div class="flex items-center gap-2 px-6 py-2 border-b border-[var(--color-border)] justify-end bg-[var(--color-bg)]">
        {status && <span class="text-[12px] text-[var(--color-text-muted)]">{status}</span>}
        <SaveButtons dirtyCount={dirty.size} saving={saving} applying={applying} onSave={() => save(false)} onSaveApply={() => save(true)} />
      </div>

      {error && <PageState error={error} />}
      {loading && rows.length === 0 && <PageState loading />}
      {!loading && rows.length === 0 && (
        <PageState empty emptyTitle="Voice War Room not enabled" emptyDescription="Set WARROOM_ENABLED=true in .env and restart to enable voice meetings." />
      )}

      {rows.length > 0 && (
        <div class={['flex-1 overflow-y-auto p-6 max-w-5xl', embedded ? '' : ''].join(' ')}>
          {!embedded && (
            <div class="text-[12px] text-[var(--color-text-muted)] mb-3 leading-relaxed">
              Save records provider-specific voices in <code class="font-mono text-[var(--color-text-faint)]">warroom/voices.json</code>. Use Mixed per-agent TTS to let each agent select its own provider; Apply bounces the Pipecat subprocess so the change takes effect immediately.
            </div>
          )}

          <div class="mb-4 grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3">
            <FieldLabel label="Audio provider">
              <select value={provider} disabled={stackSaving} onChange={(e) => void setAudioStack((e.target as HTMLSelectElement).value)} class={INPUT_CLASS}>
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </FieldLabel>
            <FieldLabel label="Output language">
              <select value={language} disabled={stackSaving} onChange={(e) => void setOutputLanguage((e.target as HTMLSelectElement).value)} class={INPUT_CLASS}>
                {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </FieldLabel>
          </div>

          <div class="space-y-1.5">
            {rows.map((r) => {
              const isDirty = dirty.has(r.agent);
              return (
                <div
                  key={r.agent}
                  class={[
                    'flex items-start gap-3 px-4 py-3 rounded-lg border transition-colors',
                    isDirty
                      ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)]'
                      : 'bg-[var(--color-card)] border-[var(--color-border)]',
                  ].join(' ')}
                >
                  <AgentAvatar agentId={r.agent} size={32} running />
                  <div class="w-28 min-w-0 pt-1">
                    <div class="text-[13.5px] text-[var(--color-text)] font-medium truncate">{r.agent}</div>
                    {isDirty && <div class="text-[10.5px] text-[var(--color-accent)]">modified</div>}
                    {r.is_default && !isDirty && <div class="text-[10.5px] text-[var(--color-text-faint)]">default</div>}
                  </div>
                  <div class="grid grid-cols-2 xl:grid-cols-6 gap-2 flex-1 min-w-0">
                    <FieldLabel label="Provider">
                      <select value={effective(r.agent, 'audio_provider')} onChange={(e) => changeField(r.agent, 'audio_provider', (e.target as HTMLSelectElement).value)} class={INPUT_CLASS}>
                        {PER_AGENT_AUDIO_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </FieldLabel>
                    <FieldLabel label="Gemini">
                      <select value={effective(r.agent, 'gemini_voice')} onChange={(e) => changeField(r.agent, 'gemini_voice', (e.target as HTMLSelectElement).value)} class={INPUT_CLASS}>
                        {catalog.map((c) => <option key={c.name} value={c.name}>{c.name} - {c.style}</option>)}
                      </select>
                    </FieldLabel>
                    <FieldLabel label="Grok">
                      <select value={effective(r.agent, 'xai_voice')} onChange={(e) => changeField(r.agent, 'xai_voice', (e.target as HTMLSelectElement).value)} class={INPUT_CLASS}>
                        {xaiCatalog.map((c) => <option key={c.name} value={c.name}>{c.name} - {c.style}</option>)}
                      </select>
                    </FieldLabel>
                    <FieldLabel label="ElevenLabs">
                      <input value={effective(r.agent, 'elevenlabs_voice_id')} onInput={(e) => changeField(r.agent, 'elevenlabs_voice_id', (e.target as HTMLInputElement).value)} placeholder="voice id" class={INPUT_CLASS} />
                    </FieldLabel>
                    <FieldLabel label="Voxtral ID">
                      <input value={effective(r.agent, 'voxtral_voice_id')} onInput={(e) => changeField(r.agent, 'voxtral_voice_id', (e.target as HTMLInputElement).value)} placeholder="saved voice id" class={INPUT_CLASS} />
                    </FieldLabel>
                    <FieldLabel label="Voxtral ref">
                      <input value={effective(r.agent, 'voxtral_ref_audio_path')} onInput={(e) => changeField(r.agent, 'voxtral_ref_audio_path', (e.target as HTMLInputElement).value)} placeholder="/path/audio.wav" class={INPUT_CLASS} />
                    </FieldLabel>
                    <FieldLabel label="Groq PlayAI">
                      <select value={effective(r.agent, 'groq_voice')} onChange={(e) => changeField(r.agent, 'groq_voice', (e.target as HTMLSelectElement).value)} class={INPUT_CLASS}>
                        {groqCatalog.map((c) => <option key={c.name} value={c.name}>{c.name} - {c.style}</option>)}
                      </select>
                    </FieldLabel>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function FieldLabel({ label, children }: { label: string; children: any }) {
  return (
    <label class="flex flex-col gap-1 text-[9.5px] uppercase tracking-wider text-[var(--color-text-faint)]">
      {label}
      {children}
    </label>
  );
}

interface SaveButtonsProps {
  dirtyCount: number;
  saving: boolean;
  applying: boolean;
  onSave: () => void;
  onSaveApply: () => void;
}

function SaveButtons({ dirtyCount, saving, applying, onSave, onSaveApply }: SaveButtonsProps) {
  return (
    <>
      <button
        type="button"
        onClick={onSave}
        disabled={dirtyCount === 0 || saving || applying}
        class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12.5px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Save size={13} /> {saving ? 'Saving...' : `Save${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`}
      </button>
      <button
        type="button"
        onClick={onSaveApply}
        disabled={dirtyCount === 0 || saving || applying}
        class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12.5px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Zap size={13} /> Save & Apply
      </button>
    </>
  );
}
