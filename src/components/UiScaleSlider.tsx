import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { useUiScale } from '../display/UiScaleContext';
import {
  DEFAULT_FONT_SCALE,
  DEFAULT_UI_SCALE,
  FONT_SCALE_STEP,
  MAX_FONT_SCALE,
  MAX_UI_SCALE,
  MIN_FONT_SCALE,
  MIN_UI_SCALE,
  UI_SCALE_STEP,
} from '../display/uiScale';

// The slider works in integer percent (80–150) to avoid floating-point noise;
// the context stores the equivalent factor (0.80–1.50).
const MIN_PERCENT = Math.round(MIN_UI_SCALE * 100);
const MAX_PERCENT = Math.round(MAX_UI_SCALE * 100);
const STEP_PERCENT = Math.round(UI_SCALE_STEP * 100);
const MIN_FONT_PERCENT = Math.round(MIN_FONT_SCALE * 100);
const MAX_FONT_PERCENT = Math.round(MAX_FONT_SCALE * 100);
const FONT_STEP_PERCENT = Math.round(FONT_SCALE_STEP * 100);

export function UiScaleSlider() {
  const { t } = useTranslation();
  const { scale, setScale, fontScale, setFontScale } = useUiScale();
  const scaleId = useId();
  const fontId = useId();
  const percent = Math.round(scale * 100);
  const fontPercent = Math.round(fontScale * 100);

  return (
    <div className="gf-ui-scale">
      <label htmlFor={scaleId} className="gf-field-label">
        {t('settings.display.scaleLabel')}
      </label>
      <div className="gf-ui-scale-row">
        <input
          id={scaleId}
          type="range"
          className="gf-range"
          min={MIN_PERCENT}
          max={MAX_PERCENT}
          step={STEP_PERCENT}
          value={percent}
          aria-valuetext={`${percent}%`}
          onChange={(event) => setScale(Number(event.target.value) / 100)}
        />
        <span className="gf-ui-scale-value" aria-hidden="true">{percent}%</span>
        <Button variant="secondary" size="sm" onClick={() => setScale(DEFAULT_UI_SCALE)}>
          {t('settings.display.reset')}
        </Button>
      </div>
      <label htmlFor={fontId} className="gf-field-label">
        {t('settings.display.fontLabel')}
      </label>
      <div className="gf-ui-scale-row">
        <input
          id={fontId}
          type="range"
          className="gf-range"
          min={MIN_FONT_PERCENT}
          max={MAX_FONT_PERCENT}
          step={FONT_STEP_PERCENT}
          value={fontPercent}
          aria-valuetext={`${fontPercent}%`}
          onChange={(event) => setFontScale(Number(event.target.value) / 100)}
        />
        <span className="gf-ui-scale-value" aria-hidden="true">{fontPercent}%</span>
        <Button variant="secondary" size="sm" onClick={() => setFontScale(DEFAULT_FONT_SCALE)}>
          {t('settings.display.reset')}
        </Button>
      </div>
    </div>
  );
}
