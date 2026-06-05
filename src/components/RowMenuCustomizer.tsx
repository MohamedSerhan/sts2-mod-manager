import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy, FolderOpen, Clock, Search, GitBranch, ExternalLink, Snowflake,
  Wrench, RotateCcw, ToggleRight, Trash2, SlidersHorizontal, GripVertical,
} from 'lucide-react';
import { Button } from './Button';
import { Toggle } from './Toggle';
import { useRowMenu } from '../contexts/RowMenuContext';
import { moveItem, type RowMenuItemId } from '../lib/rowMenuConfig';

const ITEM_ICONS: Record<string, ReactNode> = {
  membership: <ToggleRight size={13} />,
  copyVersion: <Copy size={13} />,
  openFolder: <FolderOpen size={13} />,
  snooze: <Clock size={13} />,
  autoDetect: <Search size={13} />,
  viewGithub: <GitBranch size={13} />,
  viewNexus: <ExternalLink size={13} />,
  findGithub: <GitBranch size={13} />,
  freeze: <Snowflake size={13} />,
  repair: <Wrench size={13} />,
  rollback: <RotateCcw size={13} />,
  delete: <Trash2 size={13} />,
  customize: <SlidersHorizontal size={13} />,
};

const LOCKED_IDS = ['delete', 'customize'] as const;

export function RowMenuCustomizer() {
  const { t } = useTranslation();
  const { config, setOrder, toggleHidden, reset } = useRowMenu();
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const label = (id: string) => t(`settings.rowMenu.items.${id}`);

  function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    setOrder(moveItem(config.order, dragIndex, targetIndex));
    setDragIndex(null);
  }

  return (
    <div className="space-y-3">
      <div className="gf-set-desc" style={{ marginTop: -6 }}>{t('settings.rowMenu.desc')}</div>
      <ul className="gf-row-menu-list" data-testid="row-menu-customizer-list">
        {config.order.map((id, index) => {
          const hidden = config.hidden.includes(id);
          return (
            <li
              key={id}
              data-testid={`row-menu-item-${id}`}
              data-item-id={id}
              className={`gf-row-menu-item${hidden ? ' is-hidden' : ''}`}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(index)}
              onDragEnd={() => setDragIndex(null)}
            >
              <span
                className="gf-row-menu-grip"
                aria-label={t('settings.rowMenu.dragAria', { item: label(id) })}
              >
                <GripVertical size={14} />
              </span>
              <span className="gf-row-menu-ico">{ITEM_ICONS[id]}</span>
              <span className="gf-row-menu-label">{label(id)}</span>
              <Toggle
                checked={!hidden}
                onChange={() => toggleHidden(id as RowMenuItemId)}
                ariaLabel={t('settings.rowMenu.visibleAria', { item: label(id) })}
              />
            </li>
          );
        })}
      </ul>

      <div className="gf-row-menu-locked" data-testid="row-menu-locked">
        {LOCKED_IDS.map((id) => (
          <div key={id} className="gf-row-menu-item is-locked" aria-disabled>
            <span className="gf-row-menu-grip" aria-hidden><GripVertical size={14} /></span>
            <span className="gf-row-menu-ico">{ITEM_ICONS[id]}</span>
            <span className="gf-row-menu-label">{label(id)}</span>
          </div>
        ))}
        <div className="gf-help muted"><span>{t('settings.rowMenu.lockedCaption')}</span></div>
      </div>

      <Button variant="secondary" size="sm" onClick={reset}>
        {t('settings.rowMenu.reset')}
      </Button>
    </div>
  );
}
