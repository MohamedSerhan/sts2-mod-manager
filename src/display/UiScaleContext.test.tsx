import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { UiScaleProvider, useUiScale } from './UiScaleContext';
import { FONT_SCALE_STORAGE_KEY, UI_SCALE_STORAGE_KEY } from './uiScale';

function Probe() {
  const { scale, setScale, fontScale, setFontScale } = useUiScale();
  return (
    <div>
      <span data-testid="scale">{scale}</span>
      <span data-testid="font-scale">{fontScale}</span>
      <button onClick={() => setScale(1.25)}>bump</button>
      <button onClick={() => setScale(5)}>over</button>
      <button onClick={() => setFontScale(1.15)}>text bump</button>
      <button onClick={() => setFontScale(5)}>text over</button>
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty('--ui-scale');
  document.documentElement.style.removeProperty('--font-scale');
});

describe('<UiScaleProvider>', () => {
  it('defaults to 1 and leaves the root unscaled', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByTestId('scale')).toHaveTextContent('1');
    expect(screen.getByTestId('font-scale')).toHaveTextContent('1');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('');
  });

  it('applies and persists a change', async () => {
    const user = userEvent.setup();
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    await user.click(screen.getByText('bump'));
    expect(screen.getByTestId('scale')).toHaveTextContent('1.25');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.25');
  });

  it('applies and persists a text-size change without changing interface scale', async () => {
    const user = userEvent.setup();
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    await user.click(screen.getByText('text bump'));
    expect(screen.getByTestId('font-scale')).toHaveTextContent('1.15');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.15');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
    expect(localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe('1.15');
  });

  it('clamps an out-of-range value instead of dropping it', async () => {
    const user = userEvent.setup();
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    await user.click(screen.getByText('over'));
    expect(screen.getByTestId('scale')).toHaveTextContent('1.5');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.5');
    await user.click(screen.getByText('text over'));
    expect(screen.getByTestId('font-scale')).toHaveTextContent('1.3');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.3');
  });

  it('initialises from a stored value', () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '1.2');
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, '1.15');
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByTestId('scale')).toHaveTextContent('1.2');
    expect(screen.getByTestId('font-scale')).toHaveTextContent('1.15');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.2');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.15');
  });

  it('throws when useUiScale is used outside a provider', () => {
    function Bare() { useUiScale(); return null; }
    expect(() => render(<Bare />)).toThrow(/UiScaleProvider/);
  });
});
