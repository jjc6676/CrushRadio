import {type GeneratedAlways, Kysely} from 'kysely'
import {PostgresJSDialect} from 'kysely-postgres-js'
import {DB} from './schema'
import postgres from 'postgres'

export const db = new Kysely<DB>({
  dialect: new PostgresJSDialect({
    postgres: postgres(process.env.COMBINI_DATABASE_URL, {
      prepare: false,
      idle_timeout: 10,
      max: 3,
    }),
  }),
})