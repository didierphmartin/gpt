/**
 * Hover peek for collapsed sidebars.
 *
 * While a sidebar is collapsed, resting the mouse on it (or on its rail) opens it as an overlay — the page content
 * does not move — and it closes again once the mouse has left every zone. The click toggle keeps pinning a sidebar
 * open or closed; a peek never changes that saved state.
 *
 * The CSS of each sidebar draws the overlay for `<panel>.peek`; this helper only adds and removes that class.
 *
 *   const peek = hoverPeek({
 *       panel,                 // the element that gets the `peek` class
 *       zones: [rail, panel],  // the mouse inside any of these keeps the peek open
 *       canPeek: () => bool,   // collapsed and on a desktop screen
 *       keepOpen: () => bool,  // optional: e.g. a context menu opened from the sidebar is showing
 *       onPeek: () => {},      // optional: called just before the class is added
 *   });
 *   peek.unpeek();             // the toggle pinned or closed the sidebar: drop the overlay now
 */
(function () {
    'use strict';

    const OPEN_DELAY_MS = 150;   // crossing the rail on the way elsewhere does not open it
    const CLOSE_DELAY_MS = 300;  // a slightly shaky mouse does not make it flicker

    function hoverCapable() {
        // Touch screens have no hover: they keep the click-only behaviour.
        return !window.matchMedia || window.matchMedia('(hover: hover)').matches;
    }

    function hoverPeek({ panel, zones, canPeek, keepOpen = () => false, onPeek = () => {} }) {
        let openTimer = null;
        let closeTimer = null;
        let dragging = false;

        const peeking = () => panel.classList.contains('peek');
        const pointerInside = () => zones.some(z => z && z.matches(':hover'));

        // A field of the sidebar being edited (search, rename…) keeps it open until the field loses focus.
        const editingInside = () => {
            const el = document.activeElement;
            return !!el && panel.contains(el) && el.matches('input, textarea, select, [contenteditable="true"]');
        };

        const clearTimers = () => {
            clearTimeout(openTimer);
            clearTimeout(closeTimer);
            openTimer = closeTimer = null;
        };

        const unpeek = () => {
            clearTimers();
            dragging = false;
            panel.classList.remove('peek');
        };

        // Close once nothing holds the peek open; while something does, look again a moment later.
        const scheduleClose = () => {
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => {
                closeTimer = null;
                if (!peeking()) return;
                if (!canPeek()) { unpeek(); return; }   // pinned open (or the screen changed) meanwhile
                if (pointerInside() || dragging || editingInside() || keepOpen()) { scheduleClose(); return; }
                unpeek();
            }, CLOSE_DELAY_MS);
        };

        const onEnter = () => {
            clearTimeout(closeTimer);
            closeTimer = null;
            if (peeking() || openTimer || !hoverCapable() || !canPeek()) return;
            openTimer = setTimeout(() => {
                openTimer = null;
                if (!canPeek() || !pointerInside()) return;
                onPeek();
                panel.classList.add('peek');
            }, OPEN_DELAY_MS);
        };

        const onLeave = () => {
            if (openTimer && !pointerInside()) {
                clearTimeout(openTimer);
                openTimer = null;
            }
            if (peeking()) scheduleClose();
        };

        zones.forEach(z => {
            if (!z) return;
            z.addEventListener('mouseenter', onEnter);
            z.addEventListener('mouseleave', onLeave);
        });

        // Dragging a card out of a peeked sidebar (e.g. a node onto the workflow canvas) must not close it under
        // the drag; it closes after the drop if the mouse is no longer over it.
        panel.addEventListener('dragstart', () => { if (peeking()) dragging = true; });
        document.addEventListener('dragend', () => {
            if (!dragging) return;
            dragging = false;
            scheduleClose();
        });

        // A field that loses focus may be the last thing holding the peek open.
        panel.addEventListener('focusout', () => { if (peeking()) scheduleClose(); });

        return { unpeek };
    }

    window.hoverPeek = hoverPeek;
})();
