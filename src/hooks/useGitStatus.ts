import { useCallback, useEffect, useRef, useState } from "react";
import { getGitStatus } from "../core/git/status.js";

interface GitStatusState {
  branch: string | null;
  isDirty: boolean;
  isRepo: boolean;
  staged: number;
  refresh: () => void;
}

export function useGitStatus(cwd: string): GitStatusState {
  const [branch, setBranch] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isRepo, setIsRepo] = useState(false);
  const [staged, setStaged] = useState(0);
  const mountedRef = useRef(true);

  // Track previous values to avoid unnecessary re-renders
  const prevRef2 = useRef({
    branch: null as string | null,
    isDirty: false,
    isRepo: false,
    staged: 0,
  });

  const poll = useCallback(() => {
    getGitStatus(cwd)
      .then((status) => {
        if (!mountedRef.current) return;
        const prev = prevRef2.current;
        const stagedLen = status.staged.length;
        if (
          prev.isRepo === status.isRepo &&
          prev.branch === status.branch &&
          prev.isDirty === status.isDirty &&
          prev.staged === stagedLen
        )
          return;
        prev.isRepo = status.isRepo;
        prev.branch = status.branch;
        prev.isDirty = status.isDirty;
        prev.staged = stagedLen;
        setIsRepo(status.isRepo);
        setBranch(status.branch);
        setIsDirty(status.isDirty);
        setStaged(stagedLen);
      })
      .catch(() => {});
  }, [cwd]);

  useEffect(() => {
    mountedRef.current = true;
    poll();
    const interval = setInterval(poll, 5_000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [poll]);

  return { branch, isDirty, isRepo, staged, refresh: poll };
}
