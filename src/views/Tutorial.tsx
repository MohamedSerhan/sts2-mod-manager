import { useState, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { GraduationCap, User, Wrench, Clipboard, RefreshCw, Play, ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '../components/Card';
import { cn } from '../lib/utils';

interface TutorialViewProps {
  onGoToSettings?: () => void;
}

type TutorialTab = 'user' | 'creator';

export function TutorialView({ onGoToSettings }: TutorialViewProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TutorialTab>('user');

  return (
    // Wider on big screens — the old 1024 cap left huge empty gutters at full screen.
    <div className="gf-body" style={{ maxWidth: 1280 }}>
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <GraduationCap size={20} />
            {t('tutorial.title')}
          </h1>
          <p className="gf-page-sub">
            {t('tutorial.subtitle')}
          </p>
        </div>
      </div>

      <div className="gf-tabs gf-tabs-settings" style={{ marginBottom: 14 }}>
        <TabButton active={tab === 'user'} onClick={() => setTab('user')} icon={User}>
          {t('tutorial.tabs.player')}
        </TabButton>
        <TabButton active={tab === 'creator'} onClick={() => setTab('creator')} icon={Wrench}>
          {t('tutorial.tabs.creator')}
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
  const { t } = useTranslation();

  return (
    <div className="gf-tut-hero">
      <div className="gf-tut-hero-eyebrow">{t('tutorial.player.quickStart.eyebrow')}</div>
      <h2 className="gf-tut-hero-title">{t('tutorial.player.quickStart.title')}</h2>

      <div className="gf-tut-hero-grid">
        <HeroCard
          n={1}
          icon={<Clipboard size={18} />}
          title={t('tutorial.player.quickStart.step1.title')}
          body={
                <Trans
                  i18nKey="tutorial.player.quickStart.step1.body"
                  components={{
                    0: <Kbd />,
                    1: <strong />,
                    3: <strong />,
                    5: <Kbd />,
                    7: <Kbd />,
                  }}
                />
          }
        />
        <HeroCard
          n={2}
          icon={<Play size={18} />}
          title={t('tutorial.player.quickStart.step2.title')}
          body={
            <Trans
              i18nKey="tutorial.player.quickStart.step2.body"
              components={{
                0: <Kbd />,
              }}
            />
          }
        />
        <HeroCard
          n={3}
          icon={<RefreshCw size={18} />}
          title={t('tutorial.player.quickStart.step3.title')}
          body={
            <Trans
              i18nKey="tutorial.player.quickStart.step3.body"
              components={{
                0: <Kbd />,
              }}
            />
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

// Cheat items lookup keys — must match order in en.json cheatItems.*
const CHEAT_KEY_MAP = [
  'switchActive',
  'updateEverything',
  'pinMod',
  'rollBack',
  'auditMod',
  'launchVanilla',
  'addSingleMod',
  'findNewMods',
  'shareYourPack',
  'openFriendLink',
] as const;

function UserGuide({ onGoToSettings }: { onGoToSettings?: () => void }) {
  const { t } = useTranslation();
  const [showReference, setShowReference] = useState(false);

  const quickRef = useMemo(
    () =>
      CHEAT_KEY_MAP.map((key) => [
        t(`tutorial.player.cheatItems.${key}`),
        t(`tutorial.player.cheatItems.${key}Desc`),
      ] as [string, string]),
    [t],
  );

  const fullRefLabel = showReference
    ? t('tutorial.player.fullReferenceHide')
    : t('tutorial.player.fullReferenceShow');

  return (
    <>
      {/* The friend-tutorial hero is the very first thing. */}
      <FriendHero onGoToSettings={onGoToSettings} />

      {/* Cheat-sheet — surfaces fast on full screen via 4-col grid. */}
      <div style={{ marginTop: 24, marginBottom: 12 }}>
        <div className="gf-section-eyebrow" style={{ marginBottom: 10 }}>
          {t('tutorial.player.cheatSheet')}
        </div>
        <div className="gf-tut-cheat-grid">
          {quickRef.map(([title, desc], i) => (
            <div key={i} className="gf-tut-step">
              <div className="gf-tut-num">{i + 1}</div>
              <div>
                <div className="gf-tut-t">{title}</div>
                <div className="gf-tut-b">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="gf-tut-kbd-row">
        <strong style={{ color: 'var(--ink)' }}>{t('tutorial.player.tip')}</strong>
        <span style={{ marginLeft: 8 }}>
          <Trans
            i18nKey="tutorial.player.tipLaunch"
            components={{ 0: <kbd className="gf-kbd" /> }}
          />
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
        {t('tutorial.player.fullReference')}{fullRefLabel}
      </button>

      {showReference && (
        <Card className="space-y-7 gf-tut-reference">
          <p className="text-sm text-text-muted">
            {t('tutorial.player.fullReferenceIntro')}
          </p>

          <Step n={1} title={t('tutorial.player.step1.title')}>
            <Trans
              i18nKey="tutorial.player.step1.p1"
              components={{ 0: <Kbd /> }}
            />
            <p>
              {t('tutorial.player.step1.p2_prefix')}
              {onGoToSettings ? (
                <button onClick={onGoToSettings} className="text-primary hover:underline">
                  {t('tutorial.player.step1.p2_settingsLink')}
                </button>
              ) : (
                t('tutorial.player.step1.p2_settingsLink')
              )}
              <Trans
                i18nKey="tutorial.player.step1.p2_gamePath"
                components={{ 0: <Kbd />, 2: <Kbd />, 4: <Kbd />, 6: <Kbd />, 8: <Kbd />, 10: <Kbd /> }}
              />
            </p>
          </Step>

          <Step n={2} title={t('tutorial.player.step2.title')}>
            <p>{t('tutorial.player.step2.p1')}</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>{t('tutorial.player.step2.nexusTitle')}</strong>
                {' — '}{t('tutorial.player.step2.nexusDesc')}{' '}
                <em>{t('tutorial.player.step2.nexusNote')}</em>
              </li>
              <li>
                <strong>{t('tutorial.player.step2.githubTitle')}</strong>
                {' — '}{t('tutorial.player.step2.githubDesc')}
              </li>
            </ul>
          </Step>

          <Step n={3} title={t('tutorial.player.step3.title')}>
            <p>{t('tutorial.player.step3.p1')}</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>{t('tutorial.player.step3.codeTitle')}</strong>
                {' — '}
                <Trans
                  i18nKey="tutorial.player.step3.codeDesc"
                  components={{ 0: <Kbd /> }}
                />
              </li>
              <li>
                <strong>{t('tutorial.player.step3.linkTitle')}</strong>
                {' — '}
                <Trans
                  i18nKey="tutorial.player.step3.linkDesc"
                  components={{ 0: <Kbd /> }}
                />
              </li>
              <li>
                <strong>{t('tutorial.player.step3.messageTitle')}</strong>
                {' — '}{t('tutorial.player.step3.messageDesc')}
              </li>
            </ul>
            <p>
              <Trans
                i18nKey="tutorial.player.step3.whyNotSts2mm"
                components={{
                  0: <strong />,
                  1: <Kbd />,
                  2: <Kbd />,
                  3: <Kbd />,
                }}
              />
            </p>
            <p>
              <Trans
                i18nKey="tutorial.player.step3.smartRouting"
                components={{ 0: <strong /> }}
              />
            </p>
          </Step>

          <Step n={4} title={t('tutorial.player.step4.title')}>
            <p>{t('tutorial.player.step4.p1')}</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <Trans
                  i18nKey="tutorial.player.step4.githubItem"
                  components={{ 0: <Kbd /> }}
                />
              </li>
              <li>
                <Trans
                  i18nKey="tutorial.player.step4.nexusItem"
                  components={{
                    0: <Kbd />,
                    2: <strong />,
                    4: <Kbd />,
                    6: <Kbd />,
                    8: <Kbd />,
                    10: <strong />,
                    12: <Kbd />,
                    14: <code />,
                  }}
                />
              </li>
            </ul>
            <p>
              <Trans
                i18nKey="tutorial.player.step4.dragZip"
                components={{ 0: <Kbd /> }}
              />
            </p>
          </Step>

          <Step n={5} title={t('tutorial.player.step5.title')}>
            <Trans
              i18nKey="tutorial.player.step5.p1"
              components={{
                0: <strong />,
                2: <Kbd />,
                4: <Kbd />,
                6: <Kbd />,
              }}
            />
          </Step>

          <Step n={6} title={t('tutorial.player.step6.title')}>
            <Trans
              i18nKey="tutorial.player.step6.p1"
              components={{ 0: <Kbd /> }}
            />
          </Step>

          <Step n={7} title={t('tutorial.player.step7.title')}>
            <Trans
              i18nKey="tutorial.player.step7.p1"
              components={{ 0: <Kbd /> }}
            />
          </Step>

          <Step n={8} title={t('tutorial.player.step8.title')}>
            <Trans
              i18nKey="tutorial.player.step8.p1"
              components={{
                0: <Kbd />,
                2: <Kbd />,
              }}
            />
          </Step>
        </Card>
      )}
    </>
  );
}

function CreatorGuide({ onGoToSettings }: { onGoToSettings?: () => void }) {
  const { t } = useTranslation();

  return (
    <Card className="space-y-7">
      <p className="text-sm text-text-muted">
        <Trans
          i18nKey="tutorial.creator.intro"
          components={{ 0: <Kbd /> }}
        />
      </p>

      <Step n={1} title={t('tutorial.creator.step1.title')}>
        <p>{t('tutorial.creator.step1.p1')}</p>
        <ol className="list-decimal list-inside space-y-1 ml-1">
          <li>{t('tutorial.creator.step1.li1')}</li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step1.li2"
              components={{
                0: <Kbd />,
                1: <Kbd />,
                2: <Kbd />,
              }}
            />
          </li>
          <li>
            {t('tutorial.creator.step1.li3_prefix')}
            {onGoToSettings ? (
              <button onClick={onGoToSettings} className="text-primary hover:underline">
                {t('tutorial.creator.step1.li3_settingsLink')}
              </button>
            ) : (
              t('tutorial.creator.step1.li3_settingsLink')
            )}
            <Trans
              i18nKey="tutorial.creator.step1.li3_suffix"
              components={{ 0: <Kbd /> }}
            />
          </li>
        </ol>
      </Step>

      <Step n={2} title={t('tutorial.creator.step2.title')}>
        <Trans
          i18nKey="tutorial.creator.step2.p1"
          components={{
            0: <Kbd />,
            2: <Kbd />,
          }}
        />
      </Step>

      <Step n={3} title={t('tutorial.creator.step3.title')}>
        <Trans
          i18nKey="tutorial.creator.step3.p1"
          components={{
            0: <Kbd />,
            1: <Kbd />,
          }}
        />
      </Step>

      <Step n={4} title={t('tutorial.creator.step4.title')}>
        <Trans
          i18nKey="tutorial.creator.step4.p1"
          components={{
            0: <Kbd />,
            1: <Kbd />,
          }}
        />
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <Trans
              i18nKey="tutorial.creator.step4.codeItem"
              components={{
                0: <strong />,
                1: <Kbd />,
                3: <Kbd />,
              }}
            />
          </li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step4.linkItem"
              components={{ 0: <strong />, 2: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step4.messageItem"
              components={{ 0: <strong /> }}
            />
          </li>
        </ul>
        <p>
          <Trans
            i18nKey="tutorial.creator.step4.whyNotSts2mm"
            components={{
              0: <strong />,
              1: <Kbd />,
              2: <Kbd />,
              3: <Kbd />,
              4: <Kbd />,
            }}
          />
        </p>
        <p>{t('tutorial.creator.step4.smartRouting')}</p>
      </Step>

      <Step n={5} title={t('tutorial.creator.step5.title')}>
        <Trans
          i18nKey="tutorial.creator.step5.p1"
          components={{
            0: <Kbd />,
            2: <strong />,
          }}
        />
        <Trans
          i18nKey="tutorial.creator.step5.p2"
          components={{ 0: <Kbd /> }}
        />
      </Step>

      <Step n={6} title={t('tutorial.creator.step6.title')}>
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <Trans
              i18nKey="tutorial.creator.step6.shared"
              components={{ 0: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step6.notShared"
              components={{ 0: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step6.visibility"
              components={{
                0: <strong />,
                1: <Kbd />,
              }}
            />
          </li>
        </ul>
      </Step>

      <Step n={7} title={t('tutorial.creator.step7.title')}>
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>
            <Trans
              i18nKey="tutorial.creator.step7.audit"
              components={{
                0: <strong />,
                1: <Kbd />,
              }}
            />
          </li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step7.pin"
              components={{
                0: <strong />,
                1: <Kbd />,
              }}
            />
          </li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step7.test"
              components={{ 0: <strong /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="tutorial.creator.step7.sendLog"
              components={{
                0: <strong />,
                1: <Kbd />,
              }}
            />
          </li>
        </ul>
      </Step>
    </Card>
  );
}
