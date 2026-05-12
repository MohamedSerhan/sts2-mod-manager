import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TutorialView } from './Tutorial';

describe('<TutorialView>', () => {
  it('renders the Tutorial header', () => {
    render(<TutorialView />);
    expect(screen.getByRole('heading', { name: /Tutorial/i })).toBeInTheDocument();
  });

  it('starts on the Player tutorial tab', () => {
    render(<TutorialView />);
    // Look for content that's specific to the user guide. Any "Player"
    // text is fine — the tab label is also "Player tutorial".
    const playerBtn = screen.getByRole('button', { name: /Player tutorial/ });
    expect(playerBtn.className).toContain('active');
  });

  it('switches to the Modpack creator tab on click', async () => {
    const user = userEvent.setup();
    render(<TutorialView />);
    const creatorBtn = screen.getByRole('button', { name: /Modpack creator/ });
    await user.click(creatorBtn);
    expect(creatorBtn.className).toContain('active');
  });
});
