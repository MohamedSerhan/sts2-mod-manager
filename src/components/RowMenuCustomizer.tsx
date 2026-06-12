import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy, FolderOpen, Clock, Search, GitBranch, ExternalLink, Snowflake,
  Wrench, RotateCcw, ToggleRight, Trash2, SlidersHorizontal, GripVertical,
  ArrowUp, ArrowDown,
} from 'lucide-react';
import { Button } from './Button';
import { Toggle } from './Toggle';
import { useRowMenu } from '../contexts/RowMenuContext';
import { moveItem, type RowMenuItemId } from '../lib/rowMenuConfig';

type LockedRowMenuItemId = 'delete' | 'customize';

// Mirrors the kebab's lucide icons (LibraryRow.tsx); size 13 matches the settings-row density.
const ITEM_ICONS: Record<RowMenuItemId | LockedRowMenuItemId, ReactNode> = {
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

const LOCKED_IDS: readonly LockedRowMenuItemId[] = ['delete', 'customize'];

export function RowMenuCustomizer() {
  const { t } = useTranslation();
  const { config, setOrder, toggleHidden, setShowCustomizeEntry, reset } = useRowMenu();
  const listRef = useRef<HTMLUListElement | null>(null);
  const dragStateRef = useRef<{ from: number; over: number } | null>(null);
  const [dragState, setDragState] = useState<{ from: number; over: number } | null>(null);

  const label = (id: string) => t(`settings.rowMenu.items.${id}`);

  function setActiveDrag(next: { from: number; over: number } | null) {
    dragStateRef.current = next;
    setDragState(next);
  }

  function rowIndexAt(clientY: number): number | null {
    const list = listRef.current;
    if (!list) return null;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.gf-row-menu-item:not(.is-locked)'));
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length > 0 ? rows.length - 1 : null;
  }

  function finishDrag() {
    const state = dragStateRef.current;
    setActiveDrag(null);
    if (!state || state.from === state.over) return;
    setOrder(moveItem(config.order, state.from, state.over));
  }

  function moveBy(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= config.order.length) return;
    setOrder(moveItem(config.order, index, target));
  }

  return (
    <div className="space-y-3">
      <div className="gf-set-desc" style={{ marginTop: -6 }}>{t('settings.rowMenu.desc')}</div>
      <ul
        ref={listRef}
        className="gf-row-menu-list"
        data-testid="row-menu-customizer-list"
        onPointerMove={(event) => {
          const current = dragStateRef.current;
          if (!current) return;
          const over = rowIndexAt(event.clientY);
          if (over !== null && over !== current.over) {
            setActiveDrag({ ...current, over });
          }
        }}
        onPointerUp={finishDrag}
        onPointerCancel={() => setActiveDrag(null)}
      >
        {config.order.map((id, index) => {
          const hidden = config.hidden.includes(id);
          const itemLabel = label(id);
          return (
            <li
              key={id}
              data-testid={`row-menu-item-${id}`}
              data-item-id={id}
              className={`gf-row-menu-item${hidden ? ' is-hidden' : ''}${dragState?.from === index ? ' is-dragging' : ''}${dragState?.over === index && dragState.from !== index ? ' is-drop-target' : ''}`}
            >
              <span
                className="gf-row-menu-grip"
                aria-label={t('settings.rowMenu.dragAria', { item: itemLabel })}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  setActiveDrag({ from: index, over: index });
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    /* setPointerCapture is unavailable in some tests. */
                  }
                }}
              >
                <GripVertical size={14} />
              </span>
              <span className="gf-row-menu-ico">{ITEM_ICONS[id]}</span>
              <span className="gf-row-menu-label">{itemLabel}</span>
              <span className="gf-row-menu-reorder-actions">
                <button
                  type="button"
                  className="gf-row-menu-reorder-btn"
                  onClick={() => moveBy(index, -1)}
                  disabled={index === 0}
                  title={t('profiles.loadOrder.moveUp', { name: itemLabel })}
                  aria-label={t('profiles.loadOrder.moveUp', { name: itemLabel })}
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  type="button"
                  className="gf-row-menu-reorder-btn"
                  onClick={() => moveBy(index, 1)}
                  disabled={index === config.order.length - 1}
                  title={t('profiles.loadOrder.moveDown', { name: itemLabel })}
                  aria-label={t('profiles.loadOrder.moveDown', { name: itemLabel })}
                >
                  <ArrowDown size={12} />
                </button>
              </span>
              <Toggle
                checked={!hidden}
                onChange={() => toggleHidden(id as RowMenuItemId)}
                ariaLabel={t('settings.rowMenu.visibleAria', { item: itemLabel })}
              />
            </li>
          );
        })}
      </ul>

      <div className="gf-row-menu-locked" data-testid="row-menu-locked">
        {LOCKED_IDS.map((id) => {
          const itemLabel = label(id);
          return (
            <div key={id} className="gf-row-menu-item is-locked">
              <span className="gf-row-menu-grip" aria-hidden><GripVertical size={14} /></span>
              <span className="gf-row-menu-ico">{ITEM_ICONS[id]}</span>
              <span className="gf-row-menu-label">{itemLabel}</span>
              {id === 'customize' && (
                <Toggle
                  checked={config.showCustomizeEntry}
                  onChange={() => setShowCustomizeEntry(!config.showCustomizeEntry)}
                  ariaLabel={t('settings.rowMenu.visibleAria', { item: itemLabel })}
                />
              )}
            </div>
          );
        })}
        <div className="gf-help muted"><span>{t('settings.rowMenu.lockedCaption')}</span></div>
      </div>

      <Button variant="secondary" size="sm" onClick={reset}>
        {t('settings.rowMenu.reset')}
      </Button>
    </div>
  );
}
