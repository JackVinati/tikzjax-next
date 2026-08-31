// Placeholder so the build pipeline can be exercised before the plugin lands.
import { ENGINE_ID, WORKER_SOURCE } from 'virtual:engine';
console.log('tikzjax-next', ENGINE_ID.slice(0, 12), WORKER_SOURCE.length);
