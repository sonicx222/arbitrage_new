import { useState, useRef, useCallback, useEffect } from 'react';

const SUCCESS_MSG_MS = 3_000;
const ERROR_MSG_MS = 10_000;

export function useMutationFeedback() {
  const [actionMsg, setActionMsg] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const showSuccess = useCallback((msg: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setActionMsg(msg);
    timeoutRef.current = setTimeout(() => setActionMsg(''), SUCCESS_MSG_MS);
  }, []);

  const showError = useCallback((msg: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setActionMsg(msg);
    timeoutRef.current = setTimeout(() => setActionMsg(''), ERROR_MSG_MS);
  }, []);

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  return { actionMsg, showSuccess, showError };
}
