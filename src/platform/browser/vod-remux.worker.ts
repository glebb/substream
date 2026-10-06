import { installVodRemuxWorker, type VodRemuxWorkerScope } from "./vod-remux-engine.ts";

installVodRemuxWorker(self as unknown as VodRemuxWorkerScope);
