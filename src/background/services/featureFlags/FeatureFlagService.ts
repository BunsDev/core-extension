import EventEmitter from 'events';
import { singleton } from 'tsyringe';
import { AnalyticsService } from '../analytics/AnalyticsService';
import {
  DEFAULT_FLAGS,
  FeatureFlagEvents,
  FeatureFlags,
  FEATURE_FLAGS_OVERRIDES_KEY,
  FeatureGates,
} from './models';
import { AnalyticsEvents } from '../analytics/models';
import { LockService } from '../lock/LockService';
import { StorageService } from '../storage/StorageService';
import { formatAndLog } from '../../../utils/logging';
import { getFeatureFlags } from './utils/getFeatureFlags';

@singleton()
export class FeatureFlagService {
  #eventEmitter = new EventEmitter();
  #featureFlags = DEFAULT_FLAGS;
  #featureFlagIntervalId?: NodeJS.Timeout | null = null;

  public get featureFlags(): FeatureFlags {
    return this.#featureFlags;
  }

  private set featureFlags(newFlags: FeatureFlags) {
    if (JSON.stringify(this.#featureFlags) === JSON.stringify(newFlags)) {
      // do nothing since flags are the same
      // do not trigger new update cycles within the app
      return;
    }
    this.#featureFlags = newFlags;
    this.#eventEmitter.emit(
      FeatureFlagEvents.FEATURE_FLAG_UPDATED,
      this.#featureFlags
    );

    // We need to lock the wallet when "everything" flag is disabled.
    if (!newFlags[FeatureGates.EVERYTHING] && !this.lockService.locked) {
      this.lockService.lock();
    }
  }

  private async updateFeatureFlags(newFlags: FeatureFlags) {
    const overrides =
      (await this.storageService.loadUnencrypted<FeatureFlags>(
        FEATURE_FLAGS_OVERRIDES_KEY
      )) || {};
    const hasOverrides = Object.keys(overrides).length > 0;

    if (hasOverrides) {
      formatAndLog(`🚩 Feature Flag Overrides found`, overrides);
    }

    this.featureFlags = {
      ...newFlags,
      ...(overrides || {}),
    };
  }

  constructor(
    private analyticsService: AnalyticsService,
    private lockService: LockService,
    private storageService: StorageService
  ) {
    // start fetching feature as early as possible
    // update requests with unique id after it's available
    // if analytics is disabled `ANALYTICS_STATE_UPDATED` will never be fired
    this.initFeatureFlags().catch((e) => {
      console.error(e);
    });

    // subscribe to analytics event updates so that we can set
    // the userId in case the user has opted in for feature flags
    this.analyticsService.addListener(
      AnalyticsEvents.ANALYTICS_STATE_UPDATED,
      () => {
        if (this.#featureFlagIntervalId) {
          clearInterval(this.#featureFlagIntervalId);
        }
        this.initFeatureFlags().catch((e) => {
          console.error(e);
        });
      }
    );
  }

  ensureFlagEnabled(feature: FeatureGates) {
    if (!this.featureFlags[feature]) {
      throw new Error(`Feature (${feature}) is currently unavailable`);
    }
  }

  private async initFeatureFlags() {
    const analyticsState = await this.analyticsService.getIds();

    if (!process.env.POSTHOG_KEY) {
      throw new Error('POSTHOG_KEY missing');
    }

    const getAndDispatchFlags = async () => {
      try {
        const flags = await getFeatureFlags(
          process.env.POSTHOG_KEY,
          analyticsState?.userId ?? '',
          process.env.POSTHOG_URL ?? 'https://app.posthog.com'
        );
        await this.updateFeatureFlags(flags);
      } catch (err) {
        console.error((err as unknown as Error).message);
      }
    };

    this.#featureFlagIntervalId = setInterval(() => {
      getAndDispatchFlags();
    }, 5000);

    getAndDispatchFlags();
  }

  addListener(event: FeatureFlagEvents, callback: (data: unknown) => void) {
    this.#eventEmitter.on(event, callback);
  }
}
