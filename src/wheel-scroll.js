import { useEffect } from 'react';

const scrollsVertically = (el) => {
  const { overflowY } = getComputedStyle(el);
  return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
};

// Vertical wheel over the board scrolls it sideways, unless the pointer is over something that
// scrolls vertically itself (a long column). Horizontal trackpad swipes and modifier keys pass through.
// `deps` re-attach the listener when the board element mounts again (view switch, first load).
export function useWheelToHorizontal(ref, deps = []) {
  useEffect(() => {
    const board = ref.current;
    if (!board) return undefined;
    const onWheel = (e) => {
      if (e.ctrlKey || e.shiftKey || e.metaKey) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (board.scrollWidth <= board.clientWidth) return;
      for (let el = e.target; el && el !== board; el = el.parentElement) {
        if (scrollsVertically(el)) return;
      }
      e.preventDefault();
      board.scrollLeft += e.deltaY;
    };
    board.addEventListener('wheel', onWheel, { passive: false });
    return () => board.removeEventListener('wheel', onWheel);
  }, [ref, ...deps]);
}
