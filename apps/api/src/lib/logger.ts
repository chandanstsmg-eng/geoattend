import pino from 'pino';
import { config } from '../config.js';
import { redact } from './redact.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.refreshToken', '*.accessToken'],
    censor: '[redacted]',
  },
  serializers: {
    err: (e) => {
      const s = pino.stdSerializers.err(e);
      return { ...s, message: redact(String(s.message ?? '')), stack: redact(String(s.stack ?? '')) };
    },
  },
  ...(config.isProduction || config.isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
});
