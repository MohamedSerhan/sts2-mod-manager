import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';

import { useModalA11y } from './useModalA11y';

function Harness({
  onClose,
  enabled = true,
  empty = false,
}: {
  onClose: () => void;
  enabled?: boolean;
  empty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, onClose, enabled);
  return (
    <>
      <button data-testid="outside">outside</button>
      <div ref={ref} tabIndex={-1} data-testid="dialog">
        {!empty && (
          <>
            <button data-testid="first">first</button>
            <button data-testid="mid">mid</button>
            <button data-testid="last">last</button>
          </>
        )}
      </div>
    </>
  );
}

describe('useModalA11y', () => {
  it('moves initial focus to the first focusable element on open', () => {
    const { getByTestId } = render(<Harness onClose={() => {}} />);
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('focuses the container itself when it has no focusable children', () => {
    const { getByTestId } = render(<Harness onClose={() => {}} empty />);
    expect(document.activeElement).toBe(getByTestId('dialog'));
  });

  it('calls onClose on Escape when enabled', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness onClose={onClose} />);
    fireEvent.keyDown(getByTestId('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape when disabled', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness onClose={onClose} enabled={false} />);
    fireEvent.keyDown(getByTestId('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness onClose={onClose} />);
    fireEvent.keyDown(getByTestId('dialog'), { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('wraps Tab from the last element back to the first', () => {
    const { getByTestId } = render(<Harness onClose={() => {}} />);
    getByTestId('last').focus();
    fireEvent.keyDown(getByTestId('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('wraps Shift+Tab from the first element back to the last', () => {
    const { getByTestId } = render(<Harness onClose={() => {}} />);
    getByTestId('first').focus();
    fireEvent.keyDown(getByTestId('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('does not wrap when Tab is pressed mid-list', () => {
    const { getByTestId } = render(<Harness onClose={() => {}} />);
    getByTestId('mid').focus();
    fireEvent.keyDown(getByTestId('dialog'), { key: 'Tab' });
    // No interception — focus stays put (jsdom doesn't advance Tab itself).
    expect(document.activeElement).toBe(getByTestId('mid'));
  });

  it('pulls focus back into the dialog when Tab fires from outside', () => {
    const { getByTestId } = render(<Harness onClose={() => {}} />);
    getByTestId('outside').focus();
    fireEvent.keyDown(getByTestId('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(getByTestId('first'));
    // …and Shift+Tab from outside lands on the last.
    getByTestId('outside').focus();
    fireEvent.keyDown(getByTestId('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('prevents default Tab and refocuses the container when there are no focusables', () => {
    const { getByTestId } = render(<Harness onClose={() => {}} empty />);
    const prevented = !fireEvent.keyDown(getByTestId('dialog'), { key: 'Tab' });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(getByTestId('dialog'));
  });

  it('no-ops both effects when the ref is never attached to an element', () => {
    // Defensive guard: both effects bail at `if (!node) return` when
    // ref.current is null (the dialog never mounted). Must not focus
    // anything or attach a keydown listener. (useModalA11y.ts lines 27, 37.)
    const onClose = vi.fn();
    const before = document.activeElement;
    // The ref is created but never passed to a rendered element, so it
    // stays null through both effects.
    function Detached() {
      const ref = useRef<HTMLDivElement>(null);
      useModalA11y(ref, onClose);
      return <span>no dialog</span>;
    }
    render(<Detached />);
    // No focus moved, and an Escape anywhere doesn't reach a listener.
    expect(document.activeElement).toBe(before);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
