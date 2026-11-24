import { ManagedUpdater } from './manager.mjs';
const manager = new ManagedUpdater(process.argv[2], { healthTimeoutMs: 1000, crashAt: process.argv[3] });
const review = await manager.review('2.0.0');
await manager.apply(review.reviewId, true);
