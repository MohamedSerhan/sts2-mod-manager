import { useState } from 'react';
import { GraduationCap, User, Wrench, Clipboard, RefreshCw, Play, ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '../components/Card';
import { cn } from '../lib/utils';

interface TutorialViewProps {
  advancedMode: boolean;
  onGoToSettings?: () => void;
}

type TutorialTab = 'user' | 'creator';

export function TutorialView({ advancedMode, onGoToSettings }: TutorialViewProps) {
  const [tab, setTab] = useState<TutorialTab>('user');

  // If advanced mode gets turned off while on the creator tab, fall back.
  if (!advancedMode && tab === 'creator') {
    setTab('user');
  }

  return (
    // Wider on big screens — the old 1024 cap left huge empty gutters at full screen.
    <div className="gf-body" style={{ maxWidth: 1280 }}>
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <GraduationCap size={20} />
            Tutorial
          </h1>
          <p className="gf-page-sub">
            Bookmark this page or send the link to a friend.
          </p>
        </div>
      </div>

      <div className="gf-tabs gf-tabs-settings" style={{ marginBottom: 14 }}>
        <TabButton active={tab === 'user'} onClick={() => setTab('user')} icon={User}>
          Player tutorial
        </TabButton>
        {advancedMode && (
          <TabButton active={tab === 'creator'} onClick={() => setTab('creator')} icon={Wrench}>
            Modpack creator
          </TabButton>
        )}
      </div>

      {tab === 'user' && <UserGuide onGoToSettings={onGoToSettings} />}
      {tab === 'creator' && advancedMode && <CreatorGuide onGoToSettings={onGoToSettings} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof User;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn('gf-tab', active && 'active')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <Icon size={14} />
      {children}
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-9 h-9 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="text-base font-semibold text-text">{title}</h4>
        <div className="mt-1.5 text-sm text-text-muted space-y-2 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-surface-hover border border-border text-xs font-mono text-text">
      {children}
    </code>
  );
}

/**
 * The 80% case for almost every player: a friend sent them a share code and
 * they want their game to look like the friend's. We surface this front and
 * center as the very first thing — three big cards on full-screen, stacked
 * on narrow widths. Everything else is collapsed by default.
 */
function FriendHero({ onGoToSettings: _onGoToSettings }: { onGoToSettings?: () => void }) {
  return (
    <div className="gf-tut-hero">
      <div className="gf-tut-hero-eyebrow">Quick start · 90% of players</div>
      <h2 className="gf-tut-hero-title">Play your friend's modpack in under a minute</h2>

      <div className="gf-tut-hero-grid">
        <HeroCard
          n={1}
          icon={<Clipboard size={18} />}
          title="Paste their share code"
          body={
            <>
              They give you something like <Kbd>jess/AA5A-315D-61AE</Kbd>. Drop it in the box at the top
              of <Kbd>Home</Kbd> and click <Kbd>Add Pack</Kbd>. The app downloads every mod in their pack
              from the source.
            </>
          }
        />
        <HeroCard
          n={2}
          icon={<Play size={18} />}
          title="Hit Launch STS2"
          body={
            <>
              Bottom-left corner. The game opens through Steam with their exact mods enabled. The app
              auto-backs-up before every launch so it's always reversible.
            </>
          }
        />
        <HeroCard
          n={3}
          icon={<RefreshCw size={18} />}
          title="Stay in sync"
          body={
            <>
              When your friend updates their pack you'll see an <Kbd>Update available</Kbd> card on Home.
              One click downloads only what changed and re-applies their pack — your save is unaffected.
            </>
          }
        />
      </div>
    </div>
  );
}

function HeroCard({ n, icon, title, body }: { n: number; icon: React.ReactNode; title: string; body: React.ReactNode }) {
  return (
    <div className="gf-tut-hero-card">
      <div className="gf-tut-hero-card-head">
        <div className="gf-tut-hero-card-num">{n}</div>
        <div className="gf-tut-hero-card-ico">{icon}</div>
      </div>
      <h3 className="gf-tut-hero-card-title">{title}</h3>
      <p className="gf-tut-hero-card-body">{body}</p>
    </div>
  );
}

// Quick-reference grid (kept as the bridge between the hero and the long
// reference) — one-liners for the next-most-common things people do.
const QUICK_REF: [string, string][] = [
  ['Switch active pack', 'Top-bar profile chip → pick a pack.'],
  ['Update everything', 'Profiles → Update all on the active pack.'],
  ['Pin a mod', 'Mods → kebab on a mod → Pin this mod.'],
  ['Roll back', 'Settings → Backups → Restore. Auto-saved before every launch.'],
  ['Audit a mod', 'Settings → Audit → Run audit. See current vs latest at a glance.'],
  ['Launch vanilla', 'Top-bar Vanilla button — ignores your active profile.'],
  ['Add a single mod', 'Quick-add a GitHub or Nexus URL on Home.'],
  ['Find new mods', 'Browse tab → search by name.'],
];

function UserGuide({ onGoToSettings }: { onGoToSettings?: () => void }) {
  const [showReference, setShowReference] = useState(false);

  return (
    <>
      {/* The friend-tutorial hero is the very first thing. */}
      <FriendHero onGoToSettings={onGoToSettings} />

      {/* Cheat-sheet — surfaces fast on full screen via 4-col grid. */}
      <div style={{ marginTop: 24, marginBottom: 12 }}>
        <div className="gf-section-eyebrow" style={{ marginBottom: 10 }}>
          Cheat sheet
        </div>
        <div className="gf-tut-cheat-grid">
          {QUICK_REF.map(([t, b], i) => (
            <div key={i} className="gf-tut-step">
              <div className="gf-tut-num">{i + 1}</div>
              <div>
                <div className="gf-tut-t">{t}</div>
                <div className="gf-tut-b">{b}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="gf-tut-kbd-row">
        <strong style={{ color: 'var(--ink)' }}>Keyboard:</strong>
        <span style={{ marginLeft: 8 }}>
          <kbd className="gf-kbd">Ctrl+L</kbd> Launch{' '}
          <kbd className="gf-kbd">Ctrl+,</kbd> Settings{' '}
          <kbd className="gf-kbd">/</kbd> Search{' '}
          <kbd className="gf-kbd">Ctrl+B</kbd> Browse{' '}
          <kbd className="gf-kbd">Esc</kbd> Close dialog
        </span>
      </div>

      {/* Long-form reference — collapsed by default so the page doesn't
          feel like a textbook. Click to expand if you really want the full
          tour. */}
      <button
        type="button"
        onClick={() => setShowReference((v) => !v)}
        className="gf-tut-reference-toggle"
      >
        {showReference ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Full reference {showReference ? '— click to hide' : '— click to expand'}
      </button>

      {showReference && (
        <Card className="space-y-7 gf-tut-reference">
          <p className="text-sm text-text-muted">
            For when something doesn't fit the quick start above. Most players never need any of this.
          </p>

          <Step n={1} title="First-time setup">
            <p>
              On first launch the app tries to auto-detect Slay the Spire 2 from your Steam install. If the status
              dot in the bottom-left says <Kbd>Game detected</Kbd>, you're done with this step.
            </p>
            <p>
              If not, open{' '}
              {onGoToSettings ? (
                <button onClick={onGoToSettings} className="text-primary hover:underline">
                  Settings
                </button>
              ) : (
                'Settings'
              )}{' '}
              → <Kbd>Game Path</Kbd> and either click <Kbd>Browse...</Kbd> or paste the folder where{' '}
              <Kbd>SlayTheSpire2.exe</Kbd> lives (e.g.{' '}
              <Kbd>C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2</Kbd>).
            </p>
          </Step>

          <Step n={2} title="Optional: API keys">
            <p>
              You don't need either of these to play with a friend's modpack — they only help with mods you find
              yourself.
            </p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>Nexus API key</strong> — sign up free at nexusmods.com → Profile → API Keys → "Personal
                API key". Paste into Settings → Nexus Mods API Key. Lets you Quick-Add Nexus links and browse
                Nexus mods inside the app.
              </li>
              <li>
                <strong>GitHub token</strong> — only needed if you plan to share modpacks (see the Modpack
                Creator tab in Advanced Mode). Otherwise skip.
              </li>
            </ul>
          </Step>

          <Step n={3} title="Adding individual mods">
            <p>On Home there's a Quick Add box at the top. Paste any of these:</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                A GitHub repo URL (e.g. <Kbd>https://github.com/owner/repo</Kbd>) — the app installs the latest
                release automatically.
              </li>
              <li>
                A Nexus Mods URL (e.g. <Kbd>https://www.nexusmods.com/slaythespire2/mods/123</Kbd>) — the app
                opens your browser; click <Kbd>Mod Manager Download</Kbd> on Nexus and the app catches the file
                and installs it.
              </li>
            </ul>
            <p>
              You can also drag a <Kbd>.zip</Kbd> file straight into the app window to install it.
            </p>
          </Step>

          <Step n={4} title="Turning mods on/off">
            <p>
              Mods tab. Toggle individual mods on/off. Disabled mods are kept on disk in{' '}
              <Kbd>mods_disabled/</Kbd> — turning a mod back on is instant, no re-download.
            </p>
          </Step>

          <Step n={5} title="Vanilla play">
            <p>
              Top-bar <Kbd>Vanilla</Kbd> button. Starts the game with all mods temporarily disabled. The app
              creates an auto-backup first so the next launch puts everything back exactly as it was.
            </p>
          </Step>

          <Step n={6} title="Backups & recovery">
            <p>
              The app creates an auto-backup before every game launch and before Vanilla Mode. Settings →
              Backups lists them with timestamp + size. <Kbd>Restore</Kbd> rolls your mods folder back to that
              snapshot. Only the newest 5 are kept.
            </p>
          </Step>

          <Step n={7} title="Reporting bugs">
            <p>
              Settings → <Kbd>View Logs</Kbd> opens the log file (or its folder). If something goes wrong, send
              the file to whoever's helping you debug — the log captures every download, every profile apply,
              every error.
            </p>
          </Step>
        </Card>
      )}
    </>
  );
}

function CreatorGuide({ onGoToSettings }: { onGoToSettings?: () => void }) {
  return (
    <Card className="space-y-7">
      <p className="text-sm text-text-muted">
        For modpack creators. A modpack is a named profile that captures every mod in your install (with
        its version + source). Friends paste your share code; their app downloads the same mods from the
        same sources. You don't host any files yourself — share data lives on a private gist in your
        GitHub account.
      </p>

      <Step n={1} title="Enable Advanced Mode">
        <p>
          Bottom-left of the sidebar: click <Kbd>Advanced Mode</Kbd>. This unlocks the Profiles tab and
          extra Browse/Dashboard views. You're already in advanced mode if you're reading this.
        </p>
      </Step>

      <Step n={2} title="Set up a GitHub token">
        <p>
          Sharing requires a GitHub token with the <Kbd>repo</Kbd> scope so the app can create a private
          gist on your account.
        </p>
        <ol className="list-decimal list-inside space-y-1 ml-1">
          <li>
            Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens (or
            "Tokens (classic)" — both work).
          </li>
          <li>
            Give it <Kbd>repo</Kbd> access (classic) or <Kbd>Gists: Read and write</Kbd> (fine-grained).
          </li>
          <li>
            Paste the token into{' '}
            {onGoToSettings ? (
              <button onClick={onGoToSettings} className="text-primary hover:underline">
                Settings
              </button>
            ) : (
              'Settings'
            )}{' '}
            → <Kbd>GitHub Token</Kbd> and hit Save. The token is stored in your OS keyring, not in plain
            text on disk.
          </li>
        </ol>
      </Step>

      <Step n={3} title="Install the mods you want in your modpack">
        <p>
          Use Quick Add for GitHub/Nexus links, drag-and-drop a <Kbd>.zip</Kbd>, or use the Browse tab.
          For mods that don't auto-link to a source: open Mods view → expand the mod → click{' '}
          <Kbd>Auto-detect source</Kbd> or paste the GitHub repo manually. Mods without a known source
          can still be shared (the app bundles a copy on your gist) but linking the source is preferred —
          your friends get the canonical release.
        </p>
      </Step>

      <Step n={4} title="Create a profile from your current state">
        <p>
          Open <Kbd>Profiles</Kbd> → <Kbd>Create Profile</Kbd>. Pick a name (e.g. "Co-op night" or
          "Daily-cheese-build"). The app captures your current mods folder — everything currently
          installed, with each mod's name, folder, version, and source.
        </p>
      </Step>

      <Step n={5} title="Share it">
        <p>
          On the Profiles row for your new profile, click the <Kbd>Share</Kbd> (paper plane) icon. The app
          creates a private gist on your GitHub account and shows you a code like <Kbd>you/ABC1</Kbd>.
        </p>
        <p>
          Send that code to your friends — they paste it on their Home page and they're playing your
          modpack within minutes.
        </p>
      </Step>

      <Step n={6} title="Updating your modpack">
        <p>
          Change your installed mods (install, upgrade, remove). Then on the same Profiles row, click the{' '}
          <Kbd>Re-share</Kbd> (refresh) icon. <strong>Same code, updated content.</strong> Your friends'
          apps detect the change next time they open the app and show an Update card on Home.
        </p>
        <p>
          If you want a separate version (e.g. v2 of your modpack with breaking changes), <Kbd>Duplicate</Kbd>{' '}
          the profile, rename, and Share that one — it gets its own code.
        </p>
      </Step>

      <Step n={7} title="What gets shared (and what doesn't)">
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <strong>Shared:</strong> the profile name, the list of mods, each mod's name + folder name +
            mod_id + version, and a source per mod (a GitHub repo, or — for mods without a public
            source — a direct download URL pointing back to the bundled copy on your gist).
          </li>
          <li>
            <strong>Not shared:</strong> your local mod files themselves (unless they need to be
            bundled), your save data, your API keys, anything outside the profile manifest.
          </li>
          <li>
            <strong>Privacy:</strong> the gist is private (only your token can write to it), but the
            content is fetched anonymously by your friends' apps using the gist's raw URL. Don't put
            anything secret in a profile name.
          </li>
        </ul>
      </Step>

      <Step n={8} title="Curator best practices">
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <strong>Audit before sharing.</strong> Settings → <Kbd>Audit Mod Versions</Kbd> flags mods
            without a known source — link them first, otherwise they get bundled into your gist (bigger
            footprint, slower for friends to download).
          </li>
          <li>
            <strong>Pin versions.</strong> Mods → expand a mod → <Kbd>Pin</Kbd> — pinning prevents
            auto-updates so your modpack stays reproducible.
          </li>
          <li>
            <strong>Test as a friend.</strong> The fastest way to validate a share is to ask a friend to
            paste the code on a clean install and confirm they see the same mods enabled.
          </li>
          <li>
            <strong>Send your log if things break.</strong> Settings → View Logs. Logs are detailed enough
            to diagnose most "it didn't work for my friend" reports.
          </li>
        </ul>
      </Step>
    </Card>
  );
}
