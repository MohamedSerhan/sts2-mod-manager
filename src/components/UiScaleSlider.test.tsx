import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { UiScaleProvider } from '../display/UiScaleContext';
import { FONT_SCALE_STORAGE_KEY, UI_SCALE_STORAGE_KEY } from '../display/uiScale';
import { UiScaleSlider } from './UiScaleSlider';

function renderSlider() {
  return render(<UiScaleProvider><UiScaleSlider /></UiScaleProvider>);
}

describe('<UiScaleSlider>', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--ui-scale');
    document.documentElement.style.removeProperty('--font-scale');
  });

  it('defaults to 100%', () => {
    renderSlider();
    const slider = screen.getByLabelText('Interface scale') as HTMLInputElement;
    const fontSlider = screen.getByLabelText('Text size') as HTMLInputElement;
    expect(slider.value).toBe('100');
    expect(fontSlider.value).toBe('100');
    expect(screen.getAllByText('100%')).toHaveLength(2);
  });

  it('scaling the slider applies and persists the factor', () => {
    renderSlider();
    const slider = screen.getByLabelText('Interface scale');
    fireEvent.change(slider, { target: { value: '125' } });
    expect(screen.getByText('125%')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('');
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.25');
  });

  it('text-size slider applies and persists without changing interface scale', () => {
    renderSlider();
    const slider = screen.getByLabelText('Text size');
    fireEvent.change(slider, { target: { value: '115' } });
    expect(screen.getByText('115%')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.15');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
    expect(localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe('1.15');
  });

  it('reset returns to 100% and clears the scale', async () => {
    const user = userEvent.setup();
    renderSlider();
    fireEvent.change(screen.getByLabelText('Interface scale'), { target: { value: '150' } });
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.5');
    await user.click(screen.getAllByText('Reset to 100%')[0]!);
    const slider = screen.getByLabelText('Interface scale') as HTMLInputElement;
    expect(slider.value).toBe('100');
    expect(screen.getAllByText('100%')).toHaveLength(2);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
  });

  it('text reset returns to 100% and clears only the text scale', async () => {
    const user = userEvent.setup();
    renderSlider();
    fireEvent.change(screen.getByLabelText('Interface scale'), { target: { value: '125' } });
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '130' } });
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.3');
    await user.click(screen.getAllByText('Reset to 100%')[1]!);
    const slider = screen.getByLabelText('Text size') as HTMLInputElement;
    expect(slider.value).toBe('100');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
  });
});
