import { useState } from 'react';

/** The `npx @ashish221/signal-cli init` chip with a Copy button (reused on empty + settings). */
export function CopyCommand({ command = 'npx @ashish221/signal-cli init' }: { command?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      /* clipboard unavailable — no-op */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <span className="codechip">
      <code>
        <span className="prompt" aria-hidden="true">
          $
        </span>
        {command}
      </code>
      <button type="button" className={`copybtn${copied ? ' copied' : ''}`} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
