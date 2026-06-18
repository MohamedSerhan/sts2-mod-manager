import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme/ThemeContext';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { ThemeSelect } from './ThemeSelect';

vi.mock('./Select', () => ({
  Select: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('not-a-theme')}>Bad theme</button>
  ),
}));

describe('<ThemeSelect> unsupported values', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('ignores values outside the supported theme preferences', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><ThemeSelect /></ThemeProvider>);

    await user.click(screen.getByRole('button', { name: 'Bad theme' }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
