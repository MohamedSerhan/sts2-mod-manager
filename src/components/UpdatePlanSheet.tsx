import { useMemo, useState } from 'react';
import { ExternalLink, Snowflake, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { UpdateApplyResult, UpdatePlanItem } from '../types';

function planKey(plan: UpdatePlanItem): string {
  const identity = plan.target.mod_version_id ?? plan.target.folder_name ?? plan.target.mod_id ?? plan.target.name;
  return `${identity}:${plan.provider}`;
}

export function UpdatePlanSheet({ plans, applying, onApply, onClose, onOpenSource, onUnfreeze }: {
  plans: UpdatePlanItem[];
  applying: boolean;
  onApply: (plans: UpdatePlanItem[]) => Promise<UpdateApplyResult[]>;
  onClose: () => void;
  onOpenSource: (url: string) => Promise<unknown>;
  onUnfreeze: (plan: UpdatePlanItem) => Promise<void>;
}) {
  const { t } = useTranslation();
  const selectable = useMemo(() => plans.filter((plan) => plan.selectable && plan.capability === 'downloadable'), [plans]);
  const [selected, setSelected] = useState(() => new Set(selectable.map(planKey)));
  const [results, setResults] = useState<UpdateApplyResult[] | null>(null);
  const selectedPlans = selectable.filter((plan) => selected.has(planKey(plan)));

  return (
    <div className="gf-modal-back" role="presentation">
      <section className="gf-modal gf-update-plan" role="dialog" aria-modal="true" aria-labelledby="update-plan-title">
        <div className="gf-modal-head">
          <div><div id="update-plan-title" className="gf-modal-title">{t('mods.updatePlan.title')}</div><div className="gf-modal-sub">{t('mods.updatePlan.subtitle')}</div></div>
          <button className="gf-icon-btn" onClick={onClose} disabled={applying} aria-label={t('common.close')}><X size={16} /></button>
        </div>
        <div className="gf-modal-body gf-update-plan-body">
          {!results && <div className="gf-update-plan-select-actions">
            <button className="gf-btn-3 gf-btn-sm" onClick={() => setSelected(new Set(selectable.map(planKey)))}>{t('mods.updatePlan.selectAll')}</button>
            <button className="gf-btn-3 gf-btn-sm" onClick={() => setSelected(new Set())}>{t('mods.updatePlan.selectNone')}</button>
          </div>}
          <div className="gf-update-plan-list">
            {plans.map((plan) => {
              const key = planKey(plan);
              const result = results?.find((item) => planKey({ ...plan, target: item.target }) === key);
              return <div className="gf-update-plan-row" key={key}>
                {plan.selectable && !results ? <input type="checkbox" checked={selected.has(key)} onChange={(event) => setSelected((old) => { const next = new Set(old); event.target.checked ? next.add(key) : next.delete(key); return next; })} aria-label={t('mods.updatePlan.selectItem', { name: plan.target.name })} /> : <span className="gf-update-plan-marker" aria-hidden>{plan.capability === 'frozen' ? <Snowflake size={15} /> : null}</span>}
                <div className="gf-update-plan-copy"><strong>{plan.target.name}</strong>{plan.capability !== 'steam-managed' && <span>{t('mods.updatePlan.versionChange', { current: plan.current_version, target: plan.target_version ?? t('unknown') })}</span>}<span>{result ? t(`mods.updatePlan.result.${result.status}`) : t(`mods.updatePlan.capability.${plan.capability}`)}</span></div>
                {plan.capability === 'manual' && plan.source && <button className="gf-btn-3 gf-btn-sm" onClick={() => void onOpenSource(plan.source!)}><ExternalLink size={13} />{t('mods.updatePlan.openManual')}</button>}
                {plan.capability === 'frozen' && <button className="gf-btn-3 gf-btn-sm" onClick={() => void onUnfreeze(plan)}>{t('mods.updatePlan.unfreeze')}</button>}
              </div>;
            })}
          </div>
        </div>
        <div className="gf-modal-foot gf-update-plan-foot">
          <button className="gf-btn-3" onClick={onClose} disabled={applying}>{results ? t('common.close') : t('common.cancel')}</button>
          {!results && <button className="gf-btn" disabled={applying || selectedPlans.length === 0} onClick={() => void onApply(selectedPlans).then(setResults)}>{t('mods.updatePlan.downloadSelected', { count: selectedPlans.length })}</button>}
        </div>
      </section>
    </div>
  );
}
