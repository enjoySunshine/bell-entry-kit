process.env.JWT_SECRET = "test";
process.env.SESSION_SECRET = "SESSION_SECRET";

import { createEndpoint, createRouter, defineRoom, defineServer, monitor, playground } from 'colyseus';
import { DatabaseDriver } from '@colyseus/database';
import { MyRoom } from '../MyRoom.ts';
import { database } from '../db/database.ts';

export const server = defineServer({
  // `database` boots under the Vite plugin too, and auto-mounts /auth/*
  database,
  driver: new DatabaseDriver({ database }),

  rooms: {
    my_room: defineRoom(MyRoom),
    // The browser client historically joins this alias; keep it registered so
    // the canvas scenario is reachable from `pnpm vite` as well.
    my_room_2: defineRoom(MyRoom),
    bell: defineRoom(MyRoom),
    bell_entry: defineRoom(MyRoom),
  },

  express: (app) => {
    app.get('/express-hello', (req, res) => {
      res.json({ message: 'Hello from Express!' });
    });

    app.use('/playground', playground());
    app.use('/monitor', monitor());
  },

  routes: createRouter({
    hello: createEndpoint("/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello world!" };
    }),

    time: createEndpoint("/time", { method: "GET" }, async (ctx) => {
      return { time: Date.now() };
    }),
  }),
});
