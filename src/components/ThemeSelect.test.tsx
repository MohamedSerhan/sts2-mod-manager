import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '../theme/ThemeContext';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { ThemeSelect } from './ThemeSelect';

function renderSelect() {
  return render(<ThemeProvider><ThemeSelect /></ThemeProvider>);
}

describe('<ThemeSelect>', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('renders Auto, Dark, and Light choices, defaulting to Dark', () => {
    renderSelect();
    expect(screen.getByLabelText('Theme')).toHaveValue('dark');
    expect(screen.getByRole('option', { name: 'Auto' })).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Dark' })).toHaveValue('dark');
    expect(screen.getByRole('option', { name: 'Light' })).toHaveValue('light');
  });

  it('persists a switch to Light and applies data-theme', async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.selectOptions(screen.getByLabelText('Theme'), 'light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores change events with unsupported values', () => {
    renderSelect();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'rainbow' } });
    // The guard refuses the unsupported value: the controlled select stays on
    // the default, nothing unsupported is persisted, and the applied theme is
    // unchanged. (ThemeProvider persists the resolved default on mount, so the
    // stored value is 'dark', not absent.)
    expect(select.value).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
