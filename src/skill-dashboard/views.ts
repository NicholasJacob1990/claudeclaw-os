/**
 * views.ts — Server-side HTML rendering functions (pure, return string).
 *
 * Theme: dark, monospaced, htop/btop aesthetic — no frontend framework.
 * HTMX loaded from CDN for lightweight interactivity.
 *
 * Ported from ctx_monitor.py HTML rendering.
 */

import type {
  AnnotationRow,
  DashboardStats,
  SkillListEntry,
  SuggestionRow,
} from './types.js';

// ── CSS ────────────────────────────────────────────────────────────────────

const CSS = `
  :root {
    --bg: #0d1117;
    --bg2: #161b22;
    --bg3: #21262d;
    --border: #30363d;
    --fg: #c9d1d9;
    --fg2: #8b949e;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --blue: #58a6ff;
    --purple: #bc8cff;
    --cyan: #39c5cf;
    --orange: #ffa657;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { font-size: 14px; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
    margin: 0;
    padding: 0;
    min-height: 100vh;
  }
  .topbar {
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 0.5rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 2rem;
  }
  .topbar-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--green);
    letter-spacing: 0.05em;
  }
  .nav { display: flex; gap: 1.5rem; }
  .nav a {
    color: var(--fg2);
    text-decoration: none;
    font-size: 0.85rem;
    padding: 0.2rem 0;
    border-bottom: 2px solid transparent;
  }
  .nav a:hover { color: var(--fg); border-bottom-color: var(--blue); }
  .nav a.active { color: var(--blue); border-bottom-color: var(--blue); }
  .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
  h1, h2, h3 { color: var(--fg); font-weight: 600; margin-top: 0; }
  h1 { font-size: 1.2rem; }
  h2 { font-size: 1rem; margin-bottom: 0.75rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
  .card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.9rem 1.1rem;
  }
  .card-label { color: var(--fg2); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.3rem; }
  .card-value { font-size: 1.8rem; font-weight: 700; line-height: 1; }
  .card-value.green { color: var(--green); }
  .card-value.yellow { color: var(--yellow); }
  .card-value.red { color: var(--red); }
  .card-value.blue { color: var(--blue); }
  .card a { color: var(--blue); font-size: 0.75rem; text-decoration: none; display: block; margin-top: 0.4rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.85rem; }
  th {
    text-align: left;
    padding: 0.4rem 0.75rem;
    background: var(--bg3);
    color: var(--fg2);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 0.4rem 0.75rem; border-bottom: 1px solid var(--border); color: var(--fg); }
  tr:hover td { background: var(--bg3); }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .badge-ok { background: #0d3321; color: var(--green); }
  .badge-warn { background: #2d2000; color: var(--yellow); }
  .badge-error { background: #2d0606; color: var(--red); }
  .badge-info { background: #0d1a2d; color: var(--blue); }
  .badge-pending { background: #1a1a2d; color: var(--purple); }
  .badge-approved { background: #0d3321; color: var(--green); }
  .muted { color: var(--fg2); font-size: 0.8rem; }
  code { background: var(--bg3); padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.82rem; color: var(--cyan); }
  pre { background: var(--bg3); border: 1px solid var(--border); padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.82rem; }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .section { margin-bottom: 2rem; }
  .empty { color: var(--fg2); font-style: italic; padding: 1rem 0; }
  .issue-list { list-style: none; padding: 0; margin: 0.5rem 0 0; }
  .issue-list li { display: flex; gap: 0.4rem; align-items: baseline; margin-bottom: 0.2rem; font-size: 0.82rem; }
`;

// ── Layout wrapper ──────────────────────────────────────────────────────────

function layout(title: string, body: string, activePath: string = '/'): string {
  const nav = [
    ['/', 'Home'],
    ['/skills', 'Skills'],
    ['/suggestions', 'Suggestions'],
    ['/annotations', 'Annotations'],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}" class="${href === activePath ? 'active' : ''}">${label}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(title)} — claudeclaw skills</title>
  <style>${CSS}</style>
  <script src="https://unpkg.com/htmx.org@1.9.12" defer></script>
</head>
<body>
  <div class="topbar">
    <span class="topbar-title">◈ skill-dashboard</span>
    <nav class="nav">${nav}</nav>
  </div>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

// ── Utilities ───────────────────────────────────────────────────────────────

export function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityBadge(sev: string): string {
  const cls = `badge-${sev === 'ok' ? 'ok' : sev === 'warn' ? 'warn' : sev === 'error' ? 'error' : 'info'}`;
  return `<span class="badge ${cls}">${escHtml(sev)}</span>`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// ── Page: Home ──────────────────────────────────────────────────────────────

export function renderHome(stats: DashboardStats): string {
  const { totalSkills, pendingSuggestions, recentAnnotations, healthSummary } = stats;

  const cards = `
    <div class="grid">
      <div class="card">
        <div class="card-label">Skills</div>
        <div class="card-value blue">${totalSkills}</div>
        <a href="/skills">browse →</a>
      </div>
      <div class="card">
        <div class="card-label">Health OK</div>
        <div class="card-value green">${healthSummary.ok}</div>
      </div>
      <div class="card">
        <div class="card-label">Warnings</div>
        <div class="card-value ${healthSummary.warn > 0 ? 'yellow' : 'green'}">${healthSummary.warn}</div>
      </div>
      <div class="card">
        <div class="card-label">Errors</div>
        <div class="card-value ${healthSummary.error > 0 ? 'red' : 'green'}">${healthSummary.error}</div>
      </div>
      <div class="card">
        <div class="card-label">Pending suggestions</div>
        <div class="card-value ${pendingSuggestions > 0 ? 'yellow' : 'green'}">${pendingSuggestions}</div>
        <a href="/suggestions">review →</a>
      </div>
      <div class="card">
        <div class="card-label">Annotations (7d)</div>
        <div class="card-value blue">${recentAnnotations}</div>
        <a href="/annotations">view →</a>
      </div>
    </div>`;

  const body = `
    <h1>Skill Dashboard</h1>
    ${cards}
    <div class="section muted" style="margin-top:1rem">
      <p>claudeclaw skill-dashboard — monitoring <code>~/.claude/skills/</code></p>
    </div>`;

  return layout('Home', body, '/');
}

// ── Page: Skills list ───────────────────────────────────────────────────────

export function renderSkillsList(skills: SkillListEntry[]): string {
  const rows =
    skills.length === 0
      ? `<tr><td colspan="5" class="empty">No skills found in ~/.claude/skills/</td></tr>`
      : skills
          .map(
            (s) => `
        <tr>
          <td><a href="/skills/${escHtml(s.slug)}"><code>${escHtml(s.slug)}</code></a></td>
          <td>${escHtml(s.frontmatterName ?? '—')}</td>
          <td class="muted">${escHtml(s.description ? s.description.slice(0, 80) : '—')}</td>
          <td>${severityBadge(s.severity)}</td>
          <td class="muted">${s.issueCount > 0 ? s.issueCount + ' issue(s)' : '—'}</td>
        </tr>`,
          )
          .join('');

  const body = `
    <h1>Skills</h1>
    <table>
      <thead><tr><th>Slug</th><th>Name</th><th>Description</th><th>Health</th><th>Issues</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  return layout('Skills', body, '/skills');
}

// ── Page: Skill detail ───────────────────────────────────────────────────────

export function renderSkillDetail(
  slug: string,
  content: string | null,
  health: { issues: Array<{ code: string; severity: string; message: string; line?: number }> },
): string {
  const preview = content
    ? `<pre>${escHtml(content.slice(0, 3000))}${content.length > 3000 ? '\n... (truncated)' : ''}</pre>`
    : `<p class="muted">SKILL.md not found.</p>`;

  const issueList =
    health.issues.length === 0
      ? `<p class="muted">No issues detected.</p>`
      : `<ul class="issue-list">${health.issues
          .map(
            (i) =>
              `<li>${severityBadge(i.severity)} <code>${escHtml(i.code)}</code> — ${escHtml(i.message)}${i.line ? ` <span class="muted">(line ${i.line})</span>` : ''}</li>`,
          )
          .join('')}</ul>`;

  const body = `
    <h1><a href="/skills">Skills</a> / <code>${escHtml(slug)}</code></h1>
    <div class="section">
      <h2>Health</h2>
      ${issueList}
    </div>
    <div class="section">
      <h2>SKILL.md preview</h2>
      ${preview}
    </div>`;

  return layout(`Skill: ${slug}`, body, '/skills');
}

// ── Page: Suggestions ───────────────────────────────────────────────────────

export function renderSuggestions(rows: SuggestionRow[]): string {
  const tableRows =
    rows.length === 0
      ? `<tr><td colspan="6" class="empty">No suggestions found.</td></tr>`
      : rows
          .map(
            (r) => `
        <tr>
          <td><code>${escHtml(r.signature)}</code></td>
          <td class="muted">${escHtml(r.session_id.slice(0, 12))}</td>
          <td><span class="badge badge-${r.status === 'pending' ? 'pending' : 'approved'}">${escHtml(r.status)}</span></td>
          <td>${escHtml(r.skill_name ?? '—')}</td>
          <td class="muted">${escHtml(r.model ?? '—')}</td>
          <td class="muted">${fmtDate(r.created_at)}</td>
        </tr>`,
          )
          .join('');

  const body = `
    <h1>Skill Suggestions</h1>
    <p class="muted">Auto-detected sessions that crossed the complexity threshold. Review and promote to skills.</p>
    <table>
      <thead><tr><th>Signature</th><th>Session</th><th>Status</th><th>Skill name</th><th>Model</th><th>Created</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>`;

  return layout('Suggestions', body, '/suggestions');
}

// ── Page: Annotations ────────────────────────────────────────────────────────

export function renderAnnotations(rows: AnnotationRow[]): string {
  const tableRows =
    rows.length === 0
      ? `<tr><td colspan="5" class="empty">No annotations found.</td></tr>`
      : rows
          .map(
            (r) => `
        <tr>
          <td><code>${escHtml(r.skill)}</code></td>
          <td class="muted">${escHtml(r.session_id.slice(0, 12))}</td>
          <td>${severityBadge(r.verdict)}</td>
          <td class="muted">${escHtml(r.reason ? r.reason.slice(0, 80) : '—')}</td>
          <td class="muted">${fmtDate(r.created_at)}</td>
        </tr>`,
          )
          .join('');

  const body = `
    <h1>Skill Annotations</h1>
    <p class="muted">User-feedback pairs collected from session transcripts.</p>
    <table>
      <thead><tr><th>Skill</th><th>Session</th><th>Verdict</th><th>Reason</th><th>Created</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>`;

  return layout('Annotations', body, '/annotations');
}
