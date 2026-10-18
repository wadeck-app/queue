import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  registerModule: vi.fn(),
  describeRegistration: vi.fn(),
  describeRegistrationFailure: vi.fn(),
}));
vi.mock('@wadeck-app/app-core-sdk/register', () => sdk);

import { registerWithAppCore } from './AppCoreRegistration.js';

let lines: { source: string; message: string }[];
const log = (entry: { source: string; message: string }): void => { lines.push(entry); };

beforeEach(() => {
  lines = [];
  sdk.registerModule.mockReset();
  sdk.describeRegistration.mockReset();
  sdk.describeRegistrationFailure.mockReset();
});

describe('registerWithAppCore', () => {
  it('registers the module under the id "queue" with the given manifest and logs what app-core answered', async () => {
    const outcome = { status: 'registered', port: 4850 };
    sdk.registerModule.mockResolvedValue(outcome);
    sdk.describeRegistration.mockReturnValue('module "queue" registered with app-core on port 4850');

    await registerWithAppCore('/abs/manifest.json', log);

    expect(sdk.registerModule).toHaveBeenCalledWith({ id: 'queue', manifestPath: '/abs/manifest.json' });
    expect(sdk.describeRegistration).toHaveBeenCalledWith(outcome, 'queue');
    expect(lines).toEqual([{ source: 'AppCoreRegistration', message: 'module "queue" registered with app-core on port 4850' }]);
  });

  it('logs app-core\'s own reason when it refuses the module (not a silent success)', async () => {
    sdk.registerModule.mockResolvedValue({ status: 'refused', port: 4850, httpStatus: 400, reason: 'bad manifest' });
    sdk.describeRegistration.mockReturnValue('app-core refused module "queue" (HTTP 400): bad manifest');

    await registerWithAppCore('/abs/manifest.json', log);

    expect(lines[0]!.message).toContain('bad manifest');
  });

  it('logs the failure and does not throw when the SDK rejects (invalid APP_CORE_PORT, missing manifest)', async () => {
    sdk.registerModule.mockRejectedValue(new Error('APP_CORE_PORT "abc" is not a port'));
    sdk.describeRegistrationFailure.mockReturnValue('could not register with app-core: APP_CORE_PORT "abc" is not a port');

    await expect(registerWithAppCore('/abs/manifest.json', log)).resolves.toBeUndefined();

    expect(lines).toEqual([{ source: 'AppCoreRegistration', message: 'could not register with app-core: APP_CORE_PORT "abc" is not a port' }]);
  });
});
