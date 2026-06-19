"use client";

import { useState } from "react";
import { Section } from "@/components/Section";
import { site } from "@/content";

/** 한 줄 설치. data-section="install". 복사 버튼 때문에 client 컴포넌트. */
export default function Install() {
  const { install } = site;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(install.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 클립보드 거부 시 무시 — 사용자가 수동 선택 가능 */
    }
  }

  return (
    <Section name="install" className="mx-auto w-full max-w-3xl px-6 py-20">
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {install.heading}
      </h2>
      <p className="mt-3 text-lg text-muted">{install.subheading}</p>

      <div
        data-block="install-command"
        className="mt-8 flex items-center gap-3 rounded-2xl border border-line bg-black/40 p-4"
      >
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-ink">
          {install.command}
        </code>
        <button
          type="button"
          onClick={copy}
          data-testid="copy-install"
          aria-label={install.copyLabel}
          className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/85"
        >
          {copied ? install.copiedLabel : install.copyLabel}
        </button>
      </div>

      <p className="mt-4 text-sm text-muted">{install.note}</p>

      <a
        href={install.appStore.href}
        target="_blank"
        rel="noopener noreferrer"
        data-cta="app-store"
        data-testid="cta-app-store"
        aria-label={install.appStore.label}
        className="mt-6 inline-flex items-center gap-3 rounded-2xl border border-line bg-black/40 px-5 py-3 transition-colors hover:border-accent-soft/50"
      >
        <svg
          aria-hidden
          viewBox="0 0 384 512"
          className="h-7 w-7 shrink-0 fill-ink"
        >
          <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
        </svg>
        <span className="text-left">
          <span className="block text-[11px] uppercase tracking-wide text-muted">
            {install.appStore.sublabel}
          </span>
          <span className="block text-base font-semibold text-ink">
            {install.appStore.label}
          </span>
        </span>
      </a>

      <a
        href={install.repoHref}
        target="_blank"
        rel="noopener noreferrer"
        data-cta="view-source"
        className="mt-4 block text-sm font-medium text-accent-soft underline-offset-4 hover:underline"
      >
        {install.repoLabel} →
      </a>
    </Section>
  );
}
