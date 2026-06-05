import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { UiScaleProvider } from '../display/UiScaleContext';
import { UI_SCALE_STORAGE_KEY } from '../display/uiScale';
import { UiScaleSlider } from './UiScaleSlider';

function renderSlider() {
  return render(<UiScaleProvider><UiScaleSlider /></UiScaleProvider>);
}

describe('<UiScaleSlider>', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--ui-scale');
  });

  it('defaults to 100%', () => {
    renderSlider();
    const slider = screen.getByLabelText('Interface scale') as HTMLInputElement;
    expect(slider.value).toBe('100');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('scaling the slider applies and persists the factor', () => {
    renderSlider();
    const slider = screen.getByLabelText('Interface scale');
    fireEvent.change(slider, { target: { value: '125' } });
    expect(screen.getByText('125%')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.25');
  });

  it('reset returns to 100% and clears the scale', async () => {
    const user = userEvent.setup();
    renderSlider();
    fireEvent.change(screen.getByLabelText('Interface scale'), { target: { value: '150' } });
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.5');
    await user.click(screen.getByText('Reset to 100%'));
    const slider = screen.getByLabelText('Interface scale') as HTMLInputElement;
    expect(slider.value).toBe('100');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
  });
});
