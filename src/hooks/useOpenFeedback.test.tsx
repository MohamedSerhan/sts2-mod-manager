import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useOpenFeedback } from './useOpenFeedback';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { FEEDBACK_NEXUS_POSTS_URL } from '../lib/nexusUrl';

function Harness() {
  const openFeedback = useOpenFeedback();
  return <button onClick={openFeedback}>open</button>;
}

function renderHarness() {
  return render(
    <AllProviders>
      <Harness />
    </AllProviders>,
  );
}

describe('useOpenFeedback', () => {
  it('opens the Nexus Posts URL via open_external_url', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'open' }));
    const opened = getInvokeCalls().filter((c) => c.cmd === 'open_external_url');
    expect(opened).toHaveLength(1);
    expect(opened[0].args).toEqual({ url: FEEDBACK_NEXUS_POSTS_URL });
  });

  it('toasts when opening the page fails', async () => {
    registerInvokeHandler('open_external_url', () => {
      throw new Error('no browser');
    });
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't open the Nexus page: no browser/),
      ).toBeInTheDocument();
    });
  });
});
