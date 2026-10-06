import { useEffect } from 'react';

/**
 * Adds Escape-to-close while a modal is open.
 *
 * Modals in this app are plain divs (no <dialog>), so this gives keyboard users
 * the expected way out without restructuring each component.
 */
export function useModalDismiss(isOpen: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);
}
