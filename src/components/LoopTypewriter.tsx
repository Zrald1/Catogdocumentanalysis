/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

interface LoopTypewriterProps {
  text?: string;
  className?: string;
  /** ms per character while typing (default 80) */
  typeSpeed?: number;
  /** ms per character while erasing (default 45) */
  eraseSpeed?: number;
  /** ms pause after fully typed (default 700) */
  pauseAfterType?: number;
  /** ms pause after fully erased (default 300) */
  pauseAfterErase?: number;
}

export default function LoopTypewriter({
  text = 'Working ...',
  className = '',
  typeSpeed = 80,
  eraseSpeed = 45,
  pauseAfterType = 700,
  pauseAfterErase = 300,
}: LoopTypewriterProps) {
  const [count, setCount] = useState(0);
  const [erasing, setErasing] = useState(false);

  useEffect(() => {
    if (!erasing) {
      if (count < text.length) {
        const t = setTimeout(() => setCount((c) => c + 1), typeSpeed);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setErasing(true), pauseAfterType);
      return () => clearTimeout(t);
    } else {
      if (count > 0) {
        const t = setTimeout(() => setCount((c) => c - 1), eraseSpeed);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setErasing(false), pauseAfterErase);
      return () => clearTimeout(t);
    }
  }, [count, erasing, text.length, typeSpeed, eraseSpeed, pauseAfterType, pauseAfterErase]);

  return (
    <span className={`font-mono ${className}`}>
      {text.slice(0, count)}
      <span className="animate-pulse">|</span>
    </span>
  );
}
