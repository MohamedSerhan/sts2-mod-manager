import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Play, Hammer, HelpCircle } from 'lucide-react';
import { Card } from '../components/Card';

interface HelpViewProps {
  // Kept for parity with the old TutorialView signature: App.tsx wires
  // this so a future contextual deep-link from Help can jump to
  // Settings. Currently unused — the Help view is self-contained.
  onGoToSettings?: () => void;
}

// FAQ topics, in display order. Each id corresponds to a `help.faq.<id>.q`
// + `help.faq.<id>.a` pair in the i18n bundle. Listed as a const so the
// view + tests share one source of truth for "which questions exist".
const FAQ_KEYS = [
  'modpackWhat',
  'storedMeaning',
  'githubWhy',
  'blockedUpdate',
  'freeze',
  'skipUpdate',
  'nexusManual',
  'publishedSubset',
] as const;

type FaqKey = (typeof FAQ_KEYS)[number];

/**
 * Renders the three Help content cards (Player quick start, Creator
 * quick start, FAQ). Exported separately from <HelpView> so the
 * HelpDrawer (topbar ? icon) and the Settings → Help tab can render
 * the same content without each view re-implementing the structure.
 *
 * NB: caller owns layout chrome (page header / drawer header). This
 * component renders cards only.
 */
/** A Help section card with a color-coded header (icon chip + title +
 *  divider). The `accent` drives the icon-chip tint and the step-number
 *  badges inside, so the three sections read as visually distinct
 *  groups instead of one flat wall of text. */
function HelpSection({
  accent,
  icon,
  title,
  children,
}: {
  accent: 'player' | 'creator' | 'faq';
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className={`gf-help-card gf-help-card-${accent}`}>
      <div className="gf-help-section-head">
        <span className="gf-help-section-icon">{icon}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </Card>
  );
}

export function HelpContent() {
  const { t } = useTranslation();

  return (
    <>
      <HelpSection
        accent="player"
        icon={<Play size={15} fill="currentColor" />}
        title={t('help.playerQuickStart.title')}
      >
        <ol className="gf-help-steps">
          <li>{t('help.playerQuickStart.step1')}</li>
          <li>{t('help.playerQuickStart.step2')}</li>
          <li>{t('help.playerQuickStart.step3')}</li>
          <li>{t('help.playerQuickStart.step4')}</li>
        </ol>
      </HelpSection>

      <HelpSection
        accent="creator"
        icon={<Hammer size={15} />}
        title={t('help.creatorQuickStart.title')}
      >
        <ol className="gf-help-steps">
          <li>{t('help.creatorQuickStart.step1')}</li>
          <li>{t('help.creatorQuickStart.step2')}</li>
          <li>{t('help.creatorQuickStart.step3')}</li>
          <li>{t('help.creatorQuickStart.step4')}</li>
          <li>{t('help.creatorQuickStart.step5')}</li>
        </ol>
      </HelpSection>

      <HelpSection
        accent="faq"
        icon={<HelpCircle size={15} />}
        title={t('help.faqHeading')}
      >
        <div className="gf-faq">
          {FAQ_KEYS.map((key) => (
            <FaqItem key={key} faqKey={key} />
          ))}
        </div>
      </HelpSection>
    </>
  );
}

export function HelpView({ onGoToSettings: _onGoToSettings }: HelpViewProps) {
  const { t } = useTranslation();

  return (
    <div className="gf-help-view">
      <header className="gf-help-header">
        <h1>{t('help.title')}</h1>
        <p className="gf-help-subtitle">{t('help.subtitle')}</p>
      </header>

      <HelpContent />
    </div>
  );
}

function FaqItem({ faqKey }: { faqKey: FaqKey }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className={`gf-faq-item${open ? ' open' : ''}`}>
      <button
        type="button"
        className="gf-faq-q"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronDown size={14} className={open ? '' : 'rot-r'} />
        <span>{t(`help.faq.${faqKey}.q`)}</span>
      </button>
      {open && (
        <div className="gf-faq-answer">{t(`help.faq.${faqKey}.a`)}</div>
      )}
    </div>
  );
}
