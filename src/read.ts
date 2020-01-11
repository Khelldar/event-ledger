import { promisify } from 'util';
import { Pool } from 'pg';
import { DEFAULT_LIMIT, DEFAULT_BOOKMARK_EXPIRATION_TIME } from './defaults';
import { BookmarkManager } from './BookmarkManager';
import { Event } from './types';
import { filtersToSQL, rowToEvent } from './utils';
const sleep = promisify(setTimeout);

export interface ReadOptions {
  reader: string;
  process: (events: Event[]) => Promise<void>;
  onProcessError?: (error: Error, events: Event[]) => Promise<void>;
  where?: ReadFilters;
  limit?: number;
}

export interface ReadFilters {
  types?: string[];
  aggregateIds?: string[];
  aggregateTypes?: string[];
  actors?: string[];
}

interface EventRow {
  index: number;
  partition: number;
  date_time: Date;
  type?: string;
  aggregate_type?: string;
  aggregate_id?: string;
  actor?: string;
  payload?: object;
}

export async function read(options: ReadOptions, pool: Pool, connectionString: string) {
  const { reader, process, onProcessError, where } = options;
  const limit = options.limit || DEFAULT_LIMIT;

  const bookmarkManager = await BookmarkManager({ reader, connectionString });

  async function _read() {
    const bookmark = await bookmarkManager.checkoutBookmark();
    if (!bookmark) {
      console.log(`[${reader}] no bookmarks left, sleeping for a bit...`);
      await sleep(2000);
      _read();
      return;
    }

    let bookmarkExpired = false;
    setTimeout(() => {
      bookmarkExpired = true;
    }, DEFAULT_BOOKMARK_EXPIRATION_TIME);

    const { partition } = bookmark;
    let { index } = bookmark;

    while (!bookmarkExpired) {
      const { sql, bindArgs } = filtersToSQL(4, where);

      const query = `
          SELECT *
          FROM events
          WHERE index > $1 AND partition = $2
          ${sql ? 'AND ' + sql : ''}
          ORDER BY index ASC
          LIMIT $3;`;

      const { rows } = await pool.query<EventRow>(query, [
        index,
        partition,
        limit,
        ...bindArgs,
      ]);

      if (rows.length === 0) {
        console.log(`reached the end of partition ${partition}, returning bookmark`);
        await sleep(500);
        break;
      }
      const events = rows.map(rowToEvent);

      try {
        await process(events);
      } catch (e) {
        onProcessError && (await onProcessError(e, events));
        break;
      }

      index = events[events.length - 1].index;
      await bookmarkManager.updateBookmark(index);
    }

    await bookmarkManager.returnBookmark();
    _read();
  }

  _read();
}