import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

export async function configureRealtimeScale(io, redisUrl, logger) {
  if (!redisUrl) {
    logger.info("realtime.adapter_local", { mode: "single-process" });
    return async () => {};
  }

  const publisher = createClient({ url: redisUrl });
  const subscriber = publisher.duplicate();
  publisher.on("error", (error) => logger.error("redis.publisher_error", error));
  subscriber.on("error", (error) => logger.error("redis.subscriber_error", error));

  await Promise.all([publisher.connect(), subscriber.connect()]);
  io.adapter(createAdapter(publisher, subscriber));
  logger.info("realtime.adapter_redis", { mode: "multi-process" });

  return async () => {
    await Promise.allSettled([publisher.quit(), subscriber.quit()]);
  };
}
