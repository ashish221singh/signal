import { useState } from 'react';
import { CopyCommand } from './CopyCommand';

type Path = 'agent' | 'cli';

/**
 * Two-tab setup explainer — Agent vs CLI — each with a copyable command. Shown on the
 * empty dashboard and in Settings so people can pick the path that fits how they work.
 * `align` follows the container (centered on the empty state, left in Settings).
 */
export function SetupTabs({ align = 'center' }: { align?: 'center' | 'start' }) {
  const [path, setPath] = useState<Path>('agent');

  return (
    <div className={`setup-tabs ${align === 'start' ? 'align-start' : 'align-center'}`}>
      <div className="period" role="tablist" aria-label="Setup method">
        <button
          type="button"
          role="tab"
          className={path === 'agent' ? 'on' : ''}
          aria-selected={path === 'agent'}
          onClick={() => setPath('agent')}
        >
          Agent
        </button>
        <button
          type="button"
          role="tab"
          className={path === 'cli' ? 'on' : ''}
          aria-selected={path === 'cli'}
          onClick={() => setPath('cli')}
        >
          CLI
        </button>
      </div>

      {path === 'agent' ? (
        <div className="setup-panel" role="tabpanel">
          <p>
            Working in Claude Code, Cursor, or another coding agent? Run this once — it wires Signal
            into your agent. Then just tell your agent <strong>“set up Signal feedback.”</strong> It
            interviews you, publishes the workflow, and adds the tracking code for you.
          </p>
          <CopyCommand command="npx @ashish221/signal-cli connect" />
        </div>
      ) : (
        <div className="setup-panel" role="tabpanel">
          <p>
            Prefer the terminal? <code>setup</code> walks you through the question, rating, and
            reply chips, then publishes it. <code>init</code> installs the SDK and wires{' '}
            <code>Signal.init</code> into your project.
          </p>
          <CopyCommand command="npx @ashish221/signal-cli setup" />
          <CopyCommand command="npx @ashish221/signal-cli init" />
        </div>
      )}
    </div>
  );
}
