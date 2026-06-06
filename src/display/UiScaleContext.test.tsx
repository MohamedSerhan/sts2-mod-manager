import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { UiScaleProvider, useUiScale } from './UiScaleContext';
import { UI_SCALE_STORAGE_KEY } from './uiScale';

function Probe() {
  const { scale, setScale } = useUiScale();
  return (
    <div>
      <span data-testid="scale">{scale}</span>
      <button onClick={() => setScale(1.25)}>bump</button>
      <button onClick={() => setScale(5)}>over</button>
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty('--ui-scale');
});

describe('<UiScaleProvider>', () => {
  it('defaults to 1 and leaves the root unscaled', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByTestId('scale')).toHaveTextContent('1');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
  });

  it('applies and persists a change', async () => {
    const user = userEvent.setup();
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    await user.click(screen.getByText('bump'));
    expect(screen.getByTestId('scale')).toHaveTextContent('1.25');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.25');
  });

  it('clamps an out-of-range value instead of dropping it', async () => {
    const user = userEvent.setup();
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    await user.click(screen.getByText('over'));
    expect(screen.getByTestId('scale')).toHaveTextContent('1.5');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.5');
  });

  it('initialises from a stored value', () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '1.2');
    render(<UiScaleProvider><Probe /></UiScaleProvider>);
    expect(screen.getByTestId('scale')).toHaveTextContent('1.2');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.2');
  });

  it('throws when useUiScale is used outside a provider', () => {
    function Bare() { useUiScale(); return null; }
    expect(() => render(<Bare />)).toThrow(/UiScaleProvider/);
  });
});
