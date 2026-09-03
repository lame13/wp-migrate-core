import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import type {
  ContentRecord,
  MigrationIssue,
  MigrationIssueSeverity,
  MigrationProject,
  OutputTarget,
  SourceEditor
} from "./types.js";

const severityOrder: Readonly<Record<MigrationIssueSeverity, number>> = {
  blocker: 0,
  warning: 1
};

const severityLabels: Readonly<Record<MigrationIssueSeverity, string>> = {
  blocker: "Blocker",
  warning: "Needs review"
};

const sourceKindLabels: Readonly<Record<SourceEditor, string>> = {
  classic: "Classic editor",
  gutenberg: "Gutenberg",
  elementor: "Elementor",
  mixed: "Mixed editor"
};

const targetDescriptions: Readonly<Record<OutputTarget, string>> = {
  astro: "Implemented for this demo. Its generated files are a starting point and still need manual verification.",
  next: "No Next.js output is included in this demonstration release.",
  nuxt: "No Nuxt output is included in this demonstration release."
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function humanize(value: string): string {
  const words = value.replace(/[._:/-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Site-wide";
}

function frameworkNeutralCopy(value: string): string {
  return value
    .replace(/an Astro content collection/gi, "a target content source")
    .replace(/an Astro data source/gi, "a target data source")
    .replace(/an Astro component/gi, "a target component")
    .replace(/by Astro\b/gi, "in the generated site")
    .replace(/\bAstro runtime\b/gi, "generated-site runtime");
}

function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function safeRoute(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const absoluteUrl = safeSourceUrl(value);
  if (absoluteUrl !== undefined) return absoluteUrl;

  const pathname = value.trim().split(/[?#]/, 1)[0] ?? "";
  return pathname.startsWith("/") ? pathname : undefined;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(date) + " UTC";
}

function renderTargetCard(project: MigrationProject, target: OutputTarget): string {
  void project;
  const labels: Readonly<Record<OutputTarget, string>> = { astro: "Astro", next: "Next.js", nuxt: "Nuxt" };
  const enabled = target === "astro";
  const state = enabled ? "Implemented" : "Not implemented";

  return `
    <article class="target-card${enabled ? " target-card--enabled" : ""}" aria-label="${escapeHtml(labels[target])} target: ${state}">
      <div class="target-card__top">
        <h3>${escapeHtml(labels[target])}</h3>
        <span class="target-state target-state--${enabled ? "available" : "unavailable"}">${state}</span>
      </div>
      <p>${escapeHtml(targetDescriptions[target])}</p>
      ${enabled ? "" : '<span class="target-card__notice">Not implemented in this release</span>'}
    </article>`;
}

function renderSourceBreakdown(project: MigrationProject): string {
  const sourceKinds: Record<SourceEditor, number> = { classic: 0, gutenberg: 0, elementor: 0, mixed: 0 };
  for (const record of project.records) sourceKinds[record.editor] += 1;
  const entries = (Object.entries(sourceKinds) as Array<[SourceEditor, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    return '<p class="muted">No posts or pages were included in this scan.</p>';
  }

  return `<ul class="source-breakdown">
    ${entries.map(([kind, count]) => `<li><span>${escapeHtml(sourceKindLabels[kind])}</span><strong>${count}</strong></li>`).join("\n")}
  </ul>`;
}

function renderIssue(
  issue: MigrationIssue,
  recordsById: ReadonlyMap<string, ContentRecord>
): string {
  const record = recordsById.get(issue.sourceId);
  const route = safeRoute(issue.route ?? record?.route);
  const source = record ? sourceKindLabels[record.editor] : "Site-wide";
  const affectedItem = record?.title || route || "Site-wide setting";
  const title = frameworkNeutralCopy(issue.title);
  const message = frameworkNeutralCopy(issue.message);
  const requiredAction = frameworkNeutralCopy(issue.requiredAction);
  const searchText = [title, message, requiredAction, issue.code, affectedItem, route, source]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();

  return `
    <article
      class="issue-card issue-card--${escapeHtml(issue.severity)}"
      data-issue
      data-severity="${escapeHtml(issue.severity)}"
      data-source="${escapeHtml(source.toLocaleLowerCase())}"
      data-search="${escapeHtml(searchText)}"
    >
      <div class="issue-card__heading">
        <div>
          <div class="badges">
            <span class="badge badge--${escapeHtml(issue.severity)}">${escapeHtml(severityLabels[issue.severity])}</span>
          </div>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <span class="source-label">${escapeHtml(source)}</span>
      </div>

      <dl class="affected-item">
        <div>
          <dt>Affected item</dt>
          <dd>${escapeHtml(affectedItem)}</dd>
        </div>
        ${route ? `<div><dt>Current URL</dt><dd><code>${escapeHtml(route)}</code></dd></div>` : ""}
      </dl>

      <p class="issue-message">${escapeHtml(message)}</p>

      <div class="next-action">
        <span>Next action</span>
        <p>${escapeHtml(requiredAction)}</p>
      </div>

      <details class="technical-details">
        <summary>Check details</summary>
        <dl>
          <div><dt>Check</dt><dd><code>${escapeHtml(issue.code)}</code></dd></div>
          <div><dt>Content record</dt><dd><code>${escapeHtml(issue.sourceId)}</code></dd></div>
          ${issue.nodeId ? `<div><dt>Source element</dt><dd><code>${escapeHtml(issue.nodeId)}</code></dd></div>` : ""}
        </dl>
        <p class="muted">Raw source snippets, node attributes and post metadata are intentionally omitted from this report.</p>
      </details>
    </article>`;
}

function renderIssueFilters(project: MigrationProject): string {
  const counts: Record<"all" | MigrationIssueSeverity, number> = {
    all: project.issues.length,
    blocker: 0,
    warning: 0
  };

  for (const issue of project.issues) {
    counts[issue.severity] += 1;
  }

  const sources = [...new Set(project.issues.map((issue) => {
    const record = project.records.find((candidate) => candidate.sourceId === issue.sourceId);
    return record ? sourceKindLabels[record.editor] : "Site-wide";
  }))].sort((a, b) => a.localeCompare(b));

  const button = (filter: "all" | MigrationIssueSeverity, label: string): string => `
    <button
      class="filter-button${filter === "all" ? " is-selected" : ""}"
      type="button"
      data-severity-filter="${filter}"
      aria-pressed="${filter === "all" ? "true" : "false"}"
    >${label} <span>${counts[filter]}</span></button>`;

  return `
    <div class="filter-panel" data-filter-panel>
      <div class="filter-row" role="group" aria-label="Filter by importance">
        ${button("all", "All")}
        ${button("blocker", "Blockers")}
        ${button("warning", "Needs review")}
      </div>

      <div class="filter-fields">
        <label class="search-field">
          <span>Search issues</span>
          <input type="search" data-issue-search placeholder="Page, URL, check or message" autocomplete="off">
        </label>
        <label>
          <span>Source</span>
          <select data-source-filter>
            <option value="all">All sources</option>
            ${sources.map((source) => `<option value="${escapeHtml(source.toLocaleLowerCase())}">${escapeHtml(source)}</option>`).join("\n")}
          </select>
        </label>
      </div>

      <div class="filter-result">
        <p data-result-count aria-live="polite"></p>
        <button class="link-button" type="button" data-clear-filters>Clear filters</button>
      </div>
    </div>`;
}

function reportScript(): string {
  return `
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-issue]'));
      const severityButtons = Array.from(document.querySelectorAll('[data-severity-filter]'));
      const sourceSelect = document.querySelector('[data-source-filter]');
      const searchInput = document.querySelector('[data-issue-search]');
      const count = document.querySelector('[data-result-count]');
      const empty = document.querySelector('[data-filter-empty]');
      const clear = document.querySelector('[data-clear-filters]');
      const blockerAction = document.querySelector('[data-show-blockers]');
      const prefersReducedMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (!cards.length || !sourceSelect || !searchInput || !count) return;

      let severity = 'all';

      const selectSeverity = (next) => {
        severity = next;
        severityButtons.forEach((button) => {
          const selected = button.dataset.severityFilter === severity;
          button.classList.toggle('is-selected', selected);
          button.setAttribute('aria-pressed', String(selected));
        });
      };

      const apply = () => {
        const source = sourceSelect.value;
        const query = searchInput.value.trim().toLocaleLowerCase();
        let visible = 0;

        cards.forEach((card) => {
          const matchesSeverity = severity === 'all' || card.dataset.severity === severity;
          const matchesSource = source === 'all' || card.dataset.source === source;
          const matchesSearch = !query || (card.dataset.search || '').includes(query);
          const show = matchesSeverity && matchesSource && matchesSearch;
          card.hidden = !show;
          if (show) visible += 1;
        });

        count.textContent = visible === cards.length
          ? cards.length + (cards.length === 1 ? ' issue' : ' issues')
          : visible + ' of ' + cards.length + ' issues';
        if (empty) empty.hidden = visible !== 0;
      };

      severityButtons.forEach((button) => button.addEventListener('click', () => {
        selectSeverity(button.dataset.severityFilter || 'all');
        apply();
      }));
      sourceSelect.addEventListener('change', apply);
      searchInput.addEventListener('input', apply);

      clear?.addEventListener('click', () => {
        selectSeverity('all');
        sourceSelect.value = 'all';
        searchInput.value = '';
        apply();
        searchInput.focus();
      });

      blockerAction?.addEventListener('click', () => {
        selectSeverity('blocker');
        sourceSelect.value = 'all';
        searchInput.value = '';
        apply();
        document.querySelector('#repair-queue')?.scrollIntoView({
          behavior: prefersReducedMotion ? 'auto' : 'smooth',
          block: 'start'
        });
      });

      apply();
    })();`;
}

export function renderReport(project: MigrationProject): string {
  const recordsById = new Map(project.records.map((record) => [record.sourceId, record]));
  const openIssues = project.issues;
  const openBlockers = openIssues.filter((issue) => issue.severity === "blocker");
  const openReviews = openIssues.filter((issue) => issue.severity === "warning");
  const sortedIssues = [...project.issues].sort((left, right) => {
    const severityDifference = severityOrder[left.severity] - severityOrder[right.severity];
    if (severityDifference !== 0) return severityDifference;
    return left.title.localeCompare(right.title);
  });
  const sourceUrl = safeSourceUrl(project.site.url ?? "") ?? safeSourceUrl(project.source.url ?? "");
  const siteUrl = sourceUrl ?? "Source URL unavailable";
  const blockerPhrase = `${openBlockers.length} ${openBlockers.length === 1 ? "blocker" : "blockers"}`;
  const reviewPhrase = `${openReviews.length} ${openReviews.length === 1 ? "item" : "items"}`;
  const reviewMetricText = openReviews.length === 0
    ? "No review items were flagged."
    : `${reviewPhrase} ${openReviews.length === 1 ? "needs" : "need"} review.`;
  const status = openBlockers.length > 0 ? "Blocked" : openIssues.length > 0 ? "Needs review" : "No issues flagged";
  const statusClass = openBlockers.length > 0 ? "blocked" : openIssues.length > 0 ? "review" : "ready";
  const outcomeTitle = openBlockers.length > 0
    ? `${blockerPhrase} ${openBlockers.length === 1 ? "requires" : "require"} resolution`
    : openIssues.length > 0
      ? `${reviewPhrase} ${openReviews.length === 1 ? "needs" : "need"} review`
      : "No issues were flagged by this scan";
  const outcomeText = openBlockers.length > 0
    ? `${openReviews.length > 0 ? `${reviewPhrase} also ${openReviews.length === 1 ? "needs" : "need"} review. ` : ""}This limited scan does not establish a complete migration.`
    : openIssues.length > 0
      ? "No blockers were flagged by the selected checks. Review these items before treating the generated output as complete."
      : "The selected checks did not flag issues. Visual, behavioural, URL and metadata verification is still required.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Migration review — ${escapeHtml(project.site.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --page: #f4f6f8;
      --surface: #ffffff;
      --surface-subtle: #f8fafc;
      --text: #18212f;
      --muted: #617083;
      --border: #d8dee7;
      --border-strong: #b9c3d0;
      --blue: #1359c5;
      --blue-soft: #e9f1ff;
      --green: #18724a;
      --green-soft: #e8f6ef;
      --amber: #8a5200;
      --amber-soft: #fff3d8;
      --red: #a5292a;
      --red-soft: #fdecec;
      --shadow: 0 1px 2px rgba(22, 34, 50, .06), 0 8px 24px rgba(22, 34, 50, .045);
      --radius: 12px;
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--page);
      color: var(--text);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.55;
    }
    button, input, select { font: inherit; }
    button, select { cursor: pointer; }
    button:disabled { cursor: not-allowed; }
    a { color: var(--blue); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    code { overflow-wrap: anywhere; }
    [hidden] { display: none !important; }

    .skip-link {
      position: fixed;
      z-index: 10;
      left: 16px;
      top: 12px;
      transform: translateY(-150%);
      padding: 8px 12px;
      border-radius: 8px;
      background: var(--text);
      color: #fff;
    }
    .skip-link:focus { transform: translateY(0); }
    :focus-visible { outline: 3px solid rgba(19, 89, 197, .28); outline-offset: 2px; }

    .topbar {
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, .96);
    }
    .topbar__inner,
    main {
      width: min(1160px, calc(100% - 40px));
      margin: 0 auto;
    }
    .topbar__inner {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .product { font-weight: 750; letter-spacing: -.01em; }
    .report-meta { color: var(--muted); font-size: 13px; text-align: right; }
    main { padding: 42px 0 72px; }

    .page-heading { margin-bottom: 24px; }
    .eyebrow {
      margin: 0 0 5px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 7px; font-size: clamp(29px, 4vw, 42px); line-height: 1.12; letter-spacing: -.035em; }
    h2 { margin-bottom: 6px; font-size: 22px; line-height: 1.25; letter-spacing: -.02em; }
    h3 { margin-bottom: 0; font-size: 17px; line-height: 1.35; }
    .site-url { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
    .external-link-label { white-space: nowrap; font-size: 13px; }
    .local-notice {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin: 0 0 28px;
      padding: 12px 14px;
      border: 1px solid #c8d6ea;
      border-radius: 8px;
      background: var(--blue-soft);
      color: #23436e;
      font-size: 14px;
    }
    .local-notice strong { color: var(--text); }

    .status-chip,
    .target-state,
    .badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
    }
    .status-chip { padding: 7px 10px; }
    .status-chip--blocked { background: var(--red-soft); color: var(--red); }
    .status-chip--review { background: var(--amber-soft); color: var(--amber); }
    .status-chip--ready { background: var(--green-soft); color: var(--green); }

    .outcome {
      display: flex;
      justify-content: space-between;
      gap: 32px;
      align-items: center;
      margin-bottom: 34px;
      padding: 22px 24px;
      border: 1px solid var(--border);
      border-left: 4px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .outcome--blocked { border-left-color: var(--red); }
    .outcome--review { border-left-color: var(--amber); }
    .outcome--ready { border-left-color: var(--green); }
    .outcome h2 { margin: 8px 0 5px; }
    .outcome p { max-width: 720px; margin-bottom: 0; color: var(--muted); }

    .button {
      min-height: 40px;
      padding: 9px 14px;
      border: 1px solid var(--blue);
      border-radius: 8px;
      background: var(--blue);
      color: #fff;
      font-weight: 700;
      white-space: nowrap;
    }
    .button:hover { background: #0e4cae; }
    .button--quiet {
      border-color: var(--border);
      background: var(--surface-subtle);
      color: var(--muted);
      font-weight: 600;
    }

    .section { margin-top: 38px; scroll-margin-top: 20px; }
    .section-heading { margin-bottom: 15px; }
    .section-heading p { margin: 0; color: var(--muted); }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }
    .metric,
    .panel,
    .target-card,
    .issue-card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .metric { padding: 17px 18px; }
    .metric span { display: block; margin-bottom: 5px; color: var(--muted); font-size: 13px; }
    .metric strong { display: block; font-size: 25px; line-height: 1.15; letter-spacing: -.025em; }
    .metric small { display: block; margin-top: 6px; color: var(--muted); }

    .source-grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 12px; }
    .panel { padding: 20px; }
    .panel h3 { margin-bottom: 14px; }
    .source-breakdown { margin: 0; padding: 0; list-style: none; }
    .source-breakdown li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 9px 0;
      border-top: 1px solid var(--border);
    }
    .source-breakdown li:first-child { border-top: 0; padding-top: 0; }
    .source-breakdown li:last-child { padding-bottom: 0; }
    .source-details { margin: 0; }
    .source-details div { display: grid; grid-template-columns: 125px 1fr; gap: 16px; padding: 7px 0; }
    .source-details dt { color: var(--muted); }
    .source-details dd { min-width: 0; margin: 0; font-weight: 600; overflow-wrap: anywhere; }

    .target-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .target-card { position: relative; min-height: 190px; padding: 20px; }
    .target-card--enabled { border-color: #9eb9e2; box-shadow: 0 0 0 1px #dce8fb, var(--shadow); }
    .target-card__top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .target-card p { min-height: 70px; margin: 18px 0 12px; color: var(--muted); }
    .target-state { padding: 6px 8px; }
    .target-state--available { background: var(--green-soft); color: var(--green); }
    .target-state--unavailable { background: #edf0f4; color: #5e6978; }
    .target-card__notice { display: block; color: var(--muted); font-size: 13px; font-weight: 650; }

    .filter-panel {
      margin: 17px 0 14px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .filter-row { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 15px; }
    .filter-button {
      padding: 7px 11px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: #fff;
      color: var(--text);
    }
    .filter-button:hover { border-color: var(--border-strong); }
    .filter-button.is-selected { border-color: var(--blue); background: var(--blue-soft); color: #124faa; font-weight: 700; }
    .filter-button span { margin-left: 4px; color: var(--muted); font-size: 12px; }
      .filter-fields { display: grid; grid-template-columns: minmax(220px, 1.6fr) minmax(170px, .8fr); gap: 12px; }
    .filter-fields label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; font-weight: 650; }
    .filter-fields input,
    .filter-fields select {
      width: 100%;
      height: 42px;
      padding: 8px 10px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      font-weight: 400;
    }
    .filter-result { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 24px; margin-top: 12px; }
    .filter-result p { margin: 0; color: var(--muted); font-size: 13px; }
    .link-button { padding: 3px 0; border: 0; background: transparent; color: var(--blue); font-weight: 650; }
    .link-button:hover { text-decoration: underline; }

    .issue-list { display: grid; gap: 12px; }
    .issue-card { padding: 20px 22px 19px; border-left-width: 4px; }
    .issue-card--blocker { border-left-color: var(--red); }
    .issue-card--review { border-left-color: var(--amber); }
    .issue-card--warning { border-left-color: #7a8796; }
    .issue-card__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
    .issue-card__heading h3 { margin-top: 9px; font-size: 18px; }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge { padding: 5px 8px; }
    .badge--blocker { background: var(--red-soft); color: var(--red); }
    .badge--review { background: var(--amber-soft); color: var(--amber); }
    .badge--warning, .badge--status { background: #edf0f4; color: #596675; }
    .source-label { color: var(--muted); font-size: 13px; white-space: nowrap; }

    .affected-item { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 16px 0 0; }
    .affected-item div { display: flex; flex-wrap: wrap; gap: 6px; }
    .affected-item dt { color: var(--muted); }
    .affected-item dt::after { content: ":"; }
    .affected-item dd { margin: 0; font-weight: 650; }
    .issue-message { max-width: 870px; margin: 15px 0 0; }
    .next-action { margin-top: 17px; padding: 12px 14px; border-radius: 8px; background: var(--surface-subtle); }
    .next-action span { display: block; margin-bottom: 3px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .next-action p { margin: 0; font-weight: 600; }

    .technical-details { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px; }
    .technical-details summary { width: fit-content; color: var(--blue); cursor: pointer; font-weight: 650; }
    .technical-details dl { margin: 13px 0 9px; }
    .technical-details dl div { display: flex; flex-wrap: wrap; gap: 7px; margin: 5px 0; }
    .technical-details dt { color: var(--muted); }
    .technical-details dt::after { content: ":"; }
    .technical-details dd { margin: 0; }
    .empty-state { padding: 34px 20px; border: 1px dashed var(--border-strong); border-radius: var(--radius); text-align: center; background: rgba(255,255,255,.6); }
    .empty-state h3 { margin-bottom: 4px; }
    .empty-state p { margin: 0; color: var(--muted); }
    .empty-state .link-button { margin-top: 9px; }
    .muted { color: var(--muted); }
    .footer-note { margin: 35px 0 0; color: var(--muted); font-size: 13px; }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
    }

    @media (max-width: 820px) {
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .source-grid, .target-grid { grid-template-columns: 1fr; }
      .target-card { min-height: 0; }
      .target-card p { min-height: 0; }
      .filter-fields { grid-template-columns: 1fr 1fr; }
      .search-field { grid-column: 1 / -1; }
    }

    @media (max-width: 560px) {
      .topbar__inner, main { width: min(100% - 24px, 1160px); }
      .topbar__inner { min-height: 58px; }
      .report-meta { display: none; }
      main { padding-top: 28px; }
      .outcome { align-items: stretch; flex-direction: column; gap: 17px; padding: 18px; }
      .outcome .button { width: 100%; }
      .metric-grid, .filter-fields { grid-template-columns: 1fr; }
      .search-field { grid-column: auto; }
      .source-details div { grid-template-columns: 1fr; gap: 1px; }
      .issue-card { padding: 17px 16px; }
      .issue-card__heading { flex-direction: column; gap: 8px; }
      .source-label { white-space: normal; }
      .filter-result { align-items: flex-start; }
    }

    @media print {
      body { background: #fff; }
      .topbar, .filter-panel, .button { display: none !important; }
      main { width: 100%; padding: 0; }
      .metric, .panel, .target-card, .issue-card, .outcome { box-shadow: none; break-inside: avoid; }
      .technical-details:not([open]) { display: none; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to report</a>
  <header class="topbar">
    <div class="topbar__inner">
      <div class="product">WP Migrate Core</div>
      <div class="report-meta">Local migration report · Version 0.1.1</div>
    </div>
  </header>

  <main id="main">
    <header class="page-heading">
      <p class="eyebrow">Migration review</p>
      <h1>${escapeHtml(project.site.title)}</h1>
      <p class="site-url">${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(siteUrl)} <span class="external-link-label">(opens in a new tab)</span></a>` : escapeHtml(siteUrl)}</p>
    </header>

    <aside class="local-notice" aria-label="Local report notice">
      <strong>Keep this report local.</strong>
      <span>It may contain source titles, URLs and migration identifiers. Review it before sharing; it is not a public site page.</span>
    </aside>

    <section class="outcome outcome--${statusClass}" aria-labelledby="outcome-heading">
      <div>
        <span class="status-chip status-chip--${statusClass}">${status}</span>
        <h2 id="outcome-heading">${escapeHtml(outcomeTitle)}</h2>
        <p>${escapeHtml(outcomeText)}</p>
      </div>
      ${openBlockers.length > 0 ? '<button class="button" type="button" data-show-blockers>Show blockers</button>' : ""}
    </section>

    <section class="section" aria-labelledby="source-heading">
      <div class="section-heading">
        <h2 id="source-heading">Source summary</h2>
        <p>What this limited scan detected in the WordPress export. It does not enumerate every WordPress feature.</p>
      </div>

      <div class="metric-grid">
        <article class="metric"><span>Content items</span><strong>${project.summary.records}</strong><small>Posts and pages included in this scan</small></article>
        <article class="metric"><span>Detected constructs</span><strong>${project.summary.nodes}</strong><small>Blocks, sections and widgets recognized by the parser</small></article>
        <article class="metric"><span>Supported constructs detected</span><strong>${project.summary.nativeNodes}</strong><small>Classified as directly supported by this demo</small></article>
        <article class="metric"><span>Blockers</span><strong>${openBlockers.length}</strong><small>${escapeHtml(reviewMetricText)}</small></article>
      </div>

      <div class="source-grid">
        <article class="panel">
          <h3>Editors detected</h3>
          ${renderSourceBreakdown(project)}
        </article>
        <article class="panel">
          <h3>Report details</h3>
          <dl class="source-details">
            <div><dt>Generated</dt><dd>${escapeHtml(formatDate(new Date().toISOString()))}</dd></div>
            <div><dt>Open blockers</dt><dd>${openBlockers.length}</dd></div>
            <div><dt>Needs review</dt><dd>${openReviews.length}</dd></div>
          </dl>
        </article>
      </div>
    </section>

    <section class="section" aria-labelledby="targets-heading">
      <div class="section-heading">
        <h2 id="targets-heading">Output target</h2>
        <p>Astro is the only implemented output target. Every generated output still needs verification against the source.</p>
      </div>
      <div class="target-grid">
        ${renderTargetCard(project, "astro")}
        ${renderTargetCard(project, "next")}
        ${renderTargetCard(project, "nuxt")}
      </div>
    </section>

    <section class="section" id="repair-queue" aria-labelledby="repair-heading">
      <div class="section-heading">
        <h2 id="repair-heading">Repair queue</h2>
        <p>Selected unsupported or ambiguous constructs appear here. An empty queue is not a completeness guarantee.</p>
      </div>

      ${project.issues.length > 0 ? renderIssueFilters(project) : ""}

      ${project.issues.length === 0 ? `
        <div class="empty-state">
          <h3>No items were flagged</h3>
          <p>The selected checks did not flag blockers or review items. Verify the generated site against the source before release.</p>
        </div>` : `
        <div class="issue-list" data-issue-list>
          ${sortedIssues.map((issue) => renderIssue(issue, recordsById)).join("\n")}
        </div>
        <div class="empty-state" data-filter-empty hidden>
          <h3>No matching issues</h3>
          <p>No repair items match the current filters.</p>
          <button class="link-button" type="button" data-clear-filters>Clear filters</button>
        </div>`}
    </section>

    <p class="footer-note">This local report is a limited scan summary, not confirmation of a complete migration. Verify visual, behavioural, URL and metadata outcomes against the original site.</p>
  </main>
  <script>${reportScript()}</script>
</body>
</html>`;
}

export interface WriteReportOptions {
  /** Refuse to replace an existing report file. */
  readonly noClobber?: boolean;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function writeReport(
  project: MigrationProject,
  outputPath: string,
  options: WriteReportOptions = {}
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, renderReport(project), {
      encoding: "utf8",
      ...(options.noClobber ? { flag: "wx" } : {})
    });
  } catch (error) {
    if (options.noClobber && isNodeErrorCode(error, "EEXIST")) {
      throw new Error(
        `Refusing to overwrite existing output: ${outputPath}. Choose a different --out path or remove the existing file intentionally.`
      );
    }
    throw error;
  }
}
