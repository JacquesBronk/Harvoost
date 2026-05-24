'use client';

// FEAT-002 (GitHub #6) — admin-only "Unlock week" affordance.
//
// Reopens a submitted/approved ISO-week period for a user by looping the
// per-entry admin-unlock over every locked entry in the week (backend
// POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock with { reason }, reason
// >= 20 chars). Rendered on the approvals queue rows, gated to admins by the
// caller — this component does NOT self-gate, so keep the `isAdmin(...)` check
// at the call site.

import { Button, Input, Modal, ModalContent, useToast } from '@harvoost/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { describeError } from '@/lib/api-client.js';
import {
  UNLOCK_REASON_MIN,
  isValidUnlockReason,
  unlockWeek,
} from '@/lib/timesheet-periods.js';

export interface UnlockWeekButtonProps {
  userId: string;
  /** `YYYY-Www` ISO-week token (e.g. "2026-W21"). */
  isoWeek: string;
  /** Display name for the confirmation copy. */
  userName?: string;
}

export function UnlockWeekButton({ userId, isoWeek, userName }: UnlockWeekButtonProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  // Reset the form whenever the modal (re)opens.
  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => unlockWeek(userId, isoWeek, reason.trim()),
    onSuccess: (result) => {
      const n = result.unlocked_ids.length;
      toast.success(
        'Week unlocked',
        `${n} ${n === 1 ? 'entry was' : 'entries were'} returned to draft. The week is open again.`,
      );
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet-period'] });
      setOpen(false);
    },
    onError: (err) => toast.error('Could not unlock week', describeError(err)),
  });

  const reasonValid = isValidUnlockReason(reason);
  const reasonError =
    touched && !reasonValid
      ? `Give a reason of at least ${UNLOCK_REASON_MIN} characters.`
      : undefined;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!reasonValid) return;
    mutation.mutate();
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        iconLeft={<LockOpen className="h-3.5 w-3.5" aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        Unlock week
      </Button>

      <Modal open={open} onOpenChange={setOpen}>
        {open ? (
          <ModalContent
            title={`Unlock ${isoWeek}`}
            description={
              userName
                ? `Reopen ${userName}'s submitted week so entries can be changed.`
                : 'Reopen this submitted week so entries can be changed.'
            }
            footer={
              <>
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  form="unlock-week-form"
                  variant="primary"
                  size="sm"
                  loading={mutation.isPending}
                  disabled={!reasonValid}
                >
                  Unlock week
                </Button>
              </>
            }
          >
            <form
              id="unlock-week-form"
              onSubmit={handleSubmit}
              className="flex flex-col gap-2"
            >
              <p className="text-sm text-neutral-600">
                This returns every locked entry in {isoWeek} to draft and records an
                audit entry. The employee can then edit and resubmit.
              </p>
              <Input
                label="Reason (required)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setTouched(true)}
                error={reasonError}
                hint={`At least ${UNLOCK_REASON_MIN} characters.`}
                placeholder="e.g. Correcting a misallocated project on Tuesday's entry"
              />
            </form>
          </ModalContent>
        ) : null}
      </Modal>
    </>
  );
}
