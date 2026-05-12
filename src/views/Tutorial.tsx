import { useState } from 'react';
import { GraduationCap, User, Wrench, Clipboard, RefreshCw, Play, ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '../components/Card';
import { cn } from '../lib/utils';

interface TutorialViewProps {
  onGoToSettings?: () => void;
}

type TutorialTab = 'user' | 'creator';

export function TutorialView({ onGoToSettings }: TutorialViewProps) {
  const [tab, setTab] = useState<TutorialTab>('user');

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
        <TabButton active={tab === 'creator'} onClick={() => setTab('creator')} icon={Wrench}>
          Modpack creator
        </TabButton>
      </div>

      {tab === 'user' && <UserGuide onGoToSettings={onGoToSettings} />}
      {tab === 'creator' && <CreatorGuide onGoToSettings={onGoToSettings} />}
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
          title="Click the link, or paste the code"
          body={
            <>
              Your friend sends you a code like <Kbd>jess/AA5A-315D-61AE</Kbd> or a clickable install
              link. <strong>Click the link</strong> — it opens a small page that pops up this app with
              a confirm dialog showing exactly what's about to install. <strong>Or paste the code</strong>{' '}
              into the <Kbd>Drop a code, hit Add</Kbd> box on <Kbd>Home</Kbd>. Same result either way:
              GitHub-sourced and bundled mods download automatically; any Nexus-only mods show as
              pending so you know what to grab manually.
            </>
          }
        />
        <HeroCard
          n={2}
          icon={<Play size={18} />}
          title="Hit Launch"
          body={
            <>
              Top-right of the window, or press <Kbd>Ctrl/⌘ L</Kbd>. The game opens through Steam with
              your friend's exact mods enabled. The app auto-backs-up before every launch so it's
              always reversible.
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
              One click pulls the diff and re-applies their pack (Nexus changes still need a manual
              download from Nexus). Your save is unaffected.
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
  ['Share your pack', 'Home hero → Copy link (or Copy code / Copy message). Drop in Discord.'],
  ['Open a friend’s link', 'Click their install link in chat — the manager pops up with a confirm.'],
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
        <strong style={{ color: 'var(--ink)' }}>Tip:</strong>
        <span style={{ marginLeft: 8 }}>
          <kbd className="gf-kbd">Ctrl+L</kbd> launches the active modpack from anywhere in the app.
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
              → <Kbd>Game Path</Kbd> and either click <Kbd>Browse...</Kbd> or paste the folder where the game
              files live. The signature file the app checks for depends on your OS:{' '}
              <Kbd>SlayTheSpire2.exe</Kbd> on Windows, <Kbd>SlayTheSpire2.app</Kbd> on macOS,{' '}
              <Kbd>SlayTheSpire2.pck</Kbd> on Linux. The default location on Windows is{' '}
              <Kbd>C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2</Kbd>.
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
                Nexus mods inside the app.{' '}
                <em>
                  Free-tier only. The app catches Nexus zips that land in
                  your Downloads folder when you use Slow / Manual downloads.
                  Nexus Premium's instant-download API isn't wired in, so
                  paid subscribers don't get faster downloads here.
                </em>
              </li>
              <li>
                <strong>GitHub token</strong> — only needed if you plan to share modpacks (see the Modpack
                Creator tab above). Otherwise skip.
              </li>
            </ul>
          </Step>

          <Step n={3} title="Sharing & receiving packs — code vs. link">
            <p>
              Every share surface in the app gives you three interchangeable ways to pass a pack to a
              friend, paired side-by-side: <strong>Copy code</strong>, <strong>Copy link</strong>, and{' '}
              <strong>Copy message</strong>. You'll find them on the Home hero, in each "Your other
              packs" row, on every Profiles row (inline next to the code), and in the kebab menu.
            </p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>Code</strong> — like <Kbd>jess/AA5A-315D-61AE</Kbd>. The raw thing. Friend pastes
                it into the manager's "Drop a code, hit Add" box on Home.
              </li>
              <li>
                <strong>Link</strong> — like{' '}
                <Kbd>https://mohamedserhan.github.io/sts2-mod-manager/i.html?c=jess/AA5A-315D-61AE</Kbd>.
                Discord / Slack / iMessage all turn this into a clickable URL because it's plain HTTPS.
                Friend clicks → lands on a tiny install-bridge page → clicks "Open in STS2 Mod Manager"
                → the manager pops up with the confirm dialog. Friends who don't have the manager yet
                get download links on the same page.
              </li>
              <li>
                <strong>Message</strong> — a paste-ready one-block message containing both the link and
                the raw code, plus an intro line ("Join my Slay the Spire 2 modpack…"). Drop it in a
                chat and you're done.
              </li>
            </ul>
            <p>
              <strong>Why not just paste <Kbd>sts2mm://</Kbd> URLs directly?</strong> Discord and most
              chat apps only auto-linkify <Kbd>http://</Kbd> and <Kbd>https://</Kbd> — custom protocol
              schemes show as un-clickable text. The HTTPS bridge page exists exactly to make the link
              clickable everywhere.
            </p>
            <p>
              <strong>Smart routing on the receiving end.</strong> When a friend pastes a code or clicks
              a link, the manager checks what state they're in and shows the right dialog: brand-new
              pack → confirm + install; they already have it but it's not active → "Switch to it?"; an
              update is pending → "Apply update?"; already on the latest → friendly "you're up to date"
              toast. No guessing which case applies.
            </p>
          </Step>

          <Step n={4} title="Adding individual mods">
            <p>On Home there's a Quick Add box at the top. Paste any of these:</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                A GitHub repo URL (e.g. <Kbd>https://github.com/owner/repo</Kbd>) — the app installs the latest
                release automatically.
              </li>
              <li>
                A Nexus Mods URL (e.g. <Kbd>https://www.nexusmods.com/slaythespire2/mods/123</Kbd>) — the app
                opens the mod's <strong>Files</strong> tab in your browser. Click Nexus's{' '}
                <Kbd>Slow Download</Kbd> (sometimes labelled <Kbd>Manual</Kbd>), wait the few seconds, and
                let your browser save the zip to <Kbd>~/Downloads</Kbd>. The app's downloads-folder watcher
                picks it up and installs it for you.{' '}
                <strong>Don't click <Kbd>Mod Manager Download</Kbd></strong> — that uses Nexus's
                <code>nxm://</code> deep link, which isn't wired through to the install pipeline yet, so
                nothing happens when you click it.
              </li>
            </ul>
            <p>
              You can also drag a <Kbd>.zip</Kbd> file straight into the app window to install it.
            </p>
          </Step>

          <Step n={5} title="Turning mods on/off">
            <p>
              Mods tab. Toggle individual mods on/off.{' '}
              <strong>Disabling a mod doesn't delete it</strong> — its files are moved to{' '}
              <Kbd>mods_disabled/</Kbd> alongside <Kbd>mods/</Kbd> in your game folder. Turning a mod
              back on is instant, no re-download. To permanently remove a mod, use the kebab menu →{' '}
              <Kbd>Remove mod…</Kbd>.
            </p>
          </Step>

          <Step n={6} title="Vanilla play">
            <p>
              Top-bar <Kbd>Vanilla</Kbd> button. Starts the game with all mods temporarily disabled. The app
              creates an auto-backup first so the next launch puts everything back exactly as it was.
            </p>
          </Step>

          <Step n={7} title="Backups & recovery">
            <p>
              The app creates an auto-backup before every game launch and before Vanilla Mode. Settings →
              Backups lists them with timestamp + size. <Kbd>Restore</Kbd> rolls your mods folder back to that
              snapshot. Only the newest 5 are kept.
            </p>
          </Step>

          <Step n={8} title="Reporting bugs">
            <p>
              Settings → scroll to <Kbd>In-app logs</Kbd>. The viewer has filter chips (Info / Warn / Error /
              Debug) and a <Kbd>Send to support</Kbd> button that opens a prefilled GitHub issue with the
              recent log tail. The log captures every download, every profile apply, every error.
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
        same sources. You don't host any files yourself — share data lives in a public repo
        (<Kbd>sts2mm-profiles</Kbd>) on your GitHub account that the app creates and updates for you.
      </p>

      <Step n={1} title="Set up a GitHub token">
        <p>
          Sharing requires a GitHub token with permission to create + update a repo on your account.
        </p>
        <ol className="list-decimal list-inside space-y-1 ml-1">
          <li>
            Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens (or
            "Tokens (classic)" — both work).
          </li>
          <li>
            Give it <Kbd>repo</Kbd> access (classic) or <Kbd>Contents: Read and write</Kbd> (fine-grained).
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

      <Step n={2} title="Install the mods you want in your modpack">
        <p>
          Use Quick Add for GitHub/Nexus links, drag-and-drop a <Kbd>.zip</Kbd>, or use the Browse tab.
          For mods that don't auto-link to a source: open Mods view → expand the mod → click{' '}
          <Kbd>Auto-detect source</Kbd> or paste the GitHub repo manually. Mods without a known source
          can still be shared (the app bundles a copy in your sharing repo) but linking the source is
          preferred — your friends get the canonical release.
        </p>
      </Step>

      <Step n={3} title="Create a profile from your current state">
        <p>
          Open <Kbd>Profiles</Kbd> → <Kbd>Create Profile</Kbd>. Pick a name (e.g. "Co-op night" or
          "Daily-cheese-build"). The app captures your current mods folder — everything currently
          installed, with each mod's name, folder, version, and source.
        </p>
      </Step>

      <Step n={4} title="Share it — three interchangeable formats">
        <p>
          On the Profiles row for your new profile, click the <Kbd>Share</Kbd> (paper plane) icon. The
          app uploads the manifest to your <Kbd>sts2mm-profiles</Kbd> repo (auto-creating the repo on
          first use, public, on your GitHub account) and gives you back a share code plus a success
          modal with three copy buttons. The same trio is available on every share surface (Home hero
          chip, Profiles inline chip, kebab menu, Other Packs row):
        </p>
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <strong>Copy code</strong> — the raw <Kbd>you/AA5A-315D-61AE</Kbd>. Friends paste it into the
            <Kbd>Drop a code, hit Add</Kbd> box on Home. Best for tight spaces (Twitter, terse DMs).
          </li>
          <li>
            <strong>Copy link</strong> — an HTTPS install URL pointing at the manager's bridge page on
            GitHub Pages. Discord, Slack, iMessage, Reddit etc. <em>all</em> auto-linkify this because
            it's plain HTTPS. Friend clicks → bridge page opens → bridge page fires the install
            handler in the manager → confirm dialog. Friends without the manager get download links on
            the same page.
          </li>
          <li>
            <strong>Copy message</strong> — a paste-ready one-block message containing both the link
            and the raw code, plus an intro line. Drop it in chat and you're done.
          </li>
        </ul>
        <p>
          <strong>Why we don't just hand out <Kbd>sts2mm://</Kbd> URLs directly:</strong> Discord and
          most chat apps only auto-linkify <Kbd>http://</Kbd> and <Kbd>https://</Kbd>. A raw
          <Kbd>sts2mm://import/...</Kbd> shows as un-clickable plain text the recipient has to
          select-copy and paste into a browser address bar. The HTTPS bridge page exists exactly to
          make the share link clickable everywhere a friend might paste it.
        </p>
        <p>
          The smart router on the receiving side handles brand-new installs, re-activations of an
          already-installed pack, pending updates, and "you're already on this" no-ops — your friend
          doesn't have to think about which case applies.
        </p>
      </Step>

      <Step n={5} title="Updating your modpack">
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

      <Step n={6} title="What gets shared (and what doesn't)">
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <strong>Shared:</strong> the profile name, the list of mods, each mod's name + folder name +
            mod_id + version, and a source per mod (a GitHub repo, or — for mods without a public
            source — a direct download URL pointing back to the bundled copy in your repo).
          </li>
          <li>
            <strong>Not shared:</strong> your local mod files themselves (unless they need to be
            bundled), your save data, your API keys, anything outside the profile manifest.
          </li>
          <li>
            <strong>Visibility:</strong> the <Kbd>sts2mm-profiles</Kbd> repo is public — anyone with
            your share code can read it, and the repo itself is browsable on github.com under your
            account. Don't put anything secret in a profile name or in the bundled mod files.
          </li>
        </ul>
      </Step>

      <Step n={7} title="Curator best practices">
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <strong>Audit before sharing.</strong> Settings → Audit → <Kbd>Run audit</Kbd> flags mods
            without a known source — link them first, otherwise they get bundled into your sharing repo
            (bigger footprint, slower for friends to download).
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
            <strong>Send your log if things break.</strong> Settings → In-app logs. The viewer's
            <Kbd>Send to support</Kbd> button opens a GitHub issue prefilled with the recent log tail —
            detailed enough to diagnose most "it didn't work for my friend" reports.
          </li>
        </ul>
      </Step>
    </Card>
  );
}
