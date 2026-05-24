import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
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

export function HelpView({ onGoToSettings: _onGoToSettings }: HelpViewProps) {
  const { t } = useTranslation();

  return (
    <div className="gf-help-view">
      <header className="gf-help-header">
        <h1>{t('help.title')}</h1>
        <p className="gf-help-subtitle">{t('help.subtitle')}</p>
      </header>

      <Card>
        <h2>{t('help.playerQuickStart.title')}</h2>
        <ol className="gf-help-steps">
          <li>{t('help.playerQuickStart.step1')}</li>
          <li>{t('help.playerQuickStart.step2')}</li>
          <li>{t('help.playerQuickStart.step3')}</li>
          <li>{t('help.playerQuickStart.step4')}</li>
        </ol>
      </Card>

      <Card>
        <h2>{t('help.creatorQuickStart.title')}</h2>
        <ol className="gf-help-steps">
          <li>{t('help.creatorQuickStart.step1')}</li>
          <li>{t('help.creatorQuickStart.step2')}</li>
          <li>{t('help.creatorQuickStart.step3')}</li>
          <li>{t('help.creatorQuickStart.step4')}</li>
          <li>{t('help.creatorQuickStart.step5')}</li>
        </ol>
      </Card>

      <Card>
        <h2>{t('help.faqHeading')}</h2>
        <div className="gf-faq">
          {FAQ_KEYS.map((key) => (
            <FaqItem key={key} faqKey={key} />
          ))}
        </div>
      </Card>
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
