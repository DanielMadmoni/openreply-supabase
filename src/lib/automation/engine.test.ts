import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimDueJobs: vi.fn(),
  markJobDone: vi.fn(),
  markJobFailed: vi.fn(),
  rescheduleJob: vi.fn(),
  processAutoDmJob: vi.fn(),
  processFollowUpDmJob: vi.fn(),
  processMessengerReplyJob: vi.fn(),
  pauseAccount: vi.fn(),
}));

vi.mock('@/lib/automation/queue', () => ({
  claimDueJobs: mocks.claimDueJobs,
  markJobDone: mocks.markJobDone,
  markJobFailed: mocks.markJobFailed,
  rescheduleJob: mocks.rescheduleJob,
  retryBackoffMs: () => 5000,
}));

vi.mock('@/lib/automation/processJob', () => ({
  processAutoDmJob: mocks.processAutoDmJob,
  processFollowUpDmJob: mocks.processFollowUpDmJob,
  pauseAccount: mocks.pauseAccount,
  RateLimitDelay: class RateLimitDelay extends Error {
    retryAfterMs = 1000;
  },
  AccountOnPause: class AccountOnPause extends Error {
    resumeAtMs = Date.now();
  },
}));

vi.mock('@/lib/automation/processMessengerJob', () => ({
  processMessengerReplyJob: mocks.processMessengerReplyJob,
}));

vi.mock('@/lib/debugLog', () => ({ debugLog: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { processDueJobs } from './engine';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    job_type: 'auto_dm',
    payload: { instagramAccountId: 'ig-1' },
    dedupe_key: 'k',
    status: 'processing',
    run_after: new Date().toISOString(),
    attempts: 0,
    max_attempts: 3,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.markJobDone.mockResolvedValue(undefined);
  mocks.markJobFailed.mockResolvedValue(undefined);
  mocks.rescheduleJob.mockResolvedValue(undefined);
});

describe('processDueJobs channel dispatch', () => {
  it('routes a messenger_reply job to the Messenger executor', async () => {
    const messengerJob = job({ job_type: 'messenger_reply', payload: { pageId: '111' } });
    mocks.claimDueJobs.mockResolvedValue([messengerJob]);

    const result = await processDueJobs(5);

    expect(mocks.processMessengerReplyJob).toHaveBeenCalledWith({ pageId: '111' });
    expect(mocks.processAutoDmJob).not.toHaveBeenCalled();
    expect(mocks.markJobDone).toHaveBeenCalledWith('job-1');
    expect(result.done).toBe(1);
  });

  it('still routes Instagram jobs to the auto-DM executor', async () => {
    mocks.claimDueJobs.mockResolvedValue([job()]);

    await processDueJobs(5);

    expect(mocks.processAutoDmJob).toHaveBeenCalled();
    expect(mocks.processMessengerReplyJob).not.toHaveBeenCalled();
  });

  it('retries a Messenger job that throws instead of dropping the reply', async () => {
    mocks.claimDueJobs.mockResolvedValue([job({ job_type: 'messenger_reply', payload: {} })]);
    mocks.processMessengerReplyJob.mockRejectedValue(new Error('page token missing'));

    const result = await processDueJobs(5);

    expect(mocks.rescheduleJob).toHaveBeenCalled();
    expect(result.rescheduled).toBe(1);
  });

  it('never opens the Instagram circuit breaker for a Messenger job', async () => {
    const { AccountPausedMetaError } = await import('@/lib/instagram/errors');
    mocks.claimDueJobs.mockResolvedValue([
      job({ job_type: 'messenger_reply', payload: { pageId: '111' } }),
    ]);
    mocks.processMessengerReplyJob.mockRejectedValue(
      new AccountPausedMetaError('policy block', 368, undefined)
    );

    const result = await processDueJobs(5);

    // pauseAccount takes an instagram_accounts id; a Messenger payload has
    // none, so calling it would pause nothing while looking successful.
    expect(mocks.pauseAccount).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });
});
