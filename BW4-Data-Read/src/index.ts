import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createClientFromEnv } from './bw-client.js';
import { bwQueryData, bwGetFilterValues, InfoObjectState, DrillOperation, VariableInput } from './tools/reporting.js';
import { bwGetQuery } from './tools/query.js';
import { bwSearch, bwXref } from './tools/search.js';
import { bwGetAdso } from './tools/adso.js';
import { bwGetCompositeProvider } from './tools/composite_provider.js';
import { bwListContents } from './tools/repository.js';
import { bwGetDataflow } from './tools/dataflow.js';

const server = new Server(
  { name: 'bw4-data-read', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const client = createClientFromEnv();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'bw_query_data',
      description:
        'Execute a BW query or read data from an InfoProvider via BICS protocol. ' +
        'Without state/variables: returns metadata and variable definitions (GET). ' +
        'With state/variables: returns the actual result set (POST). ' +
        'Always call without parameters first to get session-specific IDs, then POST with those IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_id: {
            type: 'string',
            description: 'Query or InfoProvider technical name (e.g. "NJ_Q001" or "NJ_ADSO1").',
          },
          is_provider: {
            type: 'boolean',
            description: 'Set to true for direct aDSO/HCPR access (adds "!" prefix). Default: false.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: '"text" (default) = formatted table; "raw" = raw XML response.',
          },
          state: {
            type: 'object',
            description: 'Axis layout and characteristic filters. Use IDs from GET response.',
            properties: {
              infoObjects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    id: { type: 'string', description: 'Session-specific ID from GET response.' },
                    axis: { type: 'string', enum: ['ROWS', 'COLUMNS', 'FREE'] },
                    hierarchy: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        hryId: { type: 'string' },
                        hryDateFrom: { type: 'string' },
                        hryDateTo: { type: 'string' },
                      },
                      required: ['id', 'name', 'hryId'],
                    },
                    filterValues: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          low: { type: 'string' },
                          lowInt: { type: 'string' },
                          lowText: { type: 'string' },
                          high: { type: 'string' },
                          op: { type: 'string' },
                          sign: { type: 'string' },
                          nodeId: { type: 'number' },
                        },
                      },
                    },
                  },
                  required: ['name', 'id', 'axis'],
                },
              },
            },
            required: ['infoObjects'],
          },
          variables: {
            type: 'array',
            description: 'Variable values. Use IDs from GET response.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                id: { type: 'string' },
                txt: { type: 'string' },
                altName: { type: 'string' },
                type: { type: 'string' },
                inputEnabled: { type: 'boolean' },
                mandatory: { type: 'boolean' },
                iobj: { type: 'string' },
                values: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      low: { type: 'string' },
                      high: { type: 'string' },
                      op: { type: 'string' },
                      sign: { type: 'string' },
                    },
                    required: ['low'],
                  },
                },
              },
              required: ['name', 'id', 'values'],
            },
          },
          from_row: { type: 'number', description: 'Pagination start (default 0).' },
          to_row: { type: 'number', description: 'Pagination end (default 1000).' },
          drill_operations: {
            type: 'array',
            description: 'Hierarchy expand/collapse operations.',
            items: {
              type: 'object',
              properties: {
                axis: { type: 'string', enum: ['ROWS', 'COLUMNS'] },
                drill_state: { type: 'number', enum: [3, 2], description: '3=expand, 2=collapse.' },
                tuple_idx: { type: 'number', description: '1-based tuple index from result.' },
                element_idx: { type: 'number' },
              },
              required: ['axis', 'drill_state', 'tuple_idx', 'element_idx'],
            },
          },
        },
        required: ['comp_id'],
      },
    },
    {
      name: 'bw_get_filter_values',
      description: 'Look up valid characteristic values for use in query filters or variables.',
      inputSchema: {
        type: 'object',
        properties: {
          characteristic_name: {
            type: 'string',
            description: 'Technical name of the characteristic (e.g. "0CALYEAR").',
          },
          search_string: {
            type: 'string',
            description: 'Search pattern. Use "*" for all values, or prefix like "2022*".',
          },
          info_provider: {
            type: 'string',
            description: 'Optional: scope results to a specific InfoProvider.',
          },
          max_rows: {
            type: 'number',
            description: 'Maximum results to return (default 201).',
          },
        },
        required: ['characteristic_name', 'search_string'],
      },
    },
    {
      name: 'bw_get_query',
      description: 'Read the full definition of a BW query (structure, variables, filters, measures).',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the BW query.',
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_search',
      description: 'Search for BW objects by name or description. Wildcards supported (e.g. "NJ_*").',
      inputSchema: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Search term with optional wildcards.',
          },
          object_type: {
            type: 'string',
            description: 'Optional object type filter: ADSO, TRFN, DTPA, IOBJ, HCPR, etc.',
          },
        },
        required: ['search_term'],
      },
    },
    {
      name: 'bw_xref',
      description: 'Find all BW objects that reference (use) the given object.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type: ADSO, TRFN, DTPA, IOBJ, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Technical name of the object.',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_adso',
      description: 'Read the XML definition of an aDSO (Advanced DataStore Object).',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'Technical name of the aDSO.',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_get_composite_provider',
      description: 'Read the definition of a CompositeProvider (HCPR): inputs, fields, join/union conditions.',
      inputSchema: {
        type: 'object',
        properties: {
          composite_provider_name: {
            type: 'string',
            description: 'Technical name of the CompositeProvider.',
          },
        },
        required: ['composite_provider_name'],
      },
    },
    {
      name: 'bw_list_contents',
      description:
        'Browse the BW InfoProvider repository. Returns a list of objects at the given path. ' +
        'Use empty string for root. Use children_path from a previous result to navigate deeper.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Repository path. Empty string = root. Example: "area/MYAREA" or "adso/MYNAME/trfn".',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'bw_get_dataflow',
      description:
        'Trace the data flow around a BW object (upwards to sources, downwards to targets, or both). ' +
        'Shows all connected objects as a tree (≤30 nodes) or flat table (>30 nodes).',
      inputSchema: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'Technical name of the object.',
          },
          object_type: {
            type: 'string',
            description: 'Object type: ADSO, HCPR, TRCS, RSDS, IOBJ, etc.',
          },
          source_system: {
            type: 'string',
            description: 'Required when object_type is RSDS: the source system name.',
          },
          direction: {
            type: 'string',
            enum: ['upwards', 'downwards', 'both'],
            description: 'Flow direction to trace.',
          },
          levels: {
            type: 'number',
            description: 'Number of levels to traverse (e.g. 5).',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: '"text" (default) = rendered tree/table; "raw" = raw XML.',
          },
        },
        required: ['object_name', 'object_type', 'direction', 'levels'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'bw_query_data': {
        const a = args as {
          comp_id: string;
          is_provider?: boolean;
          format?: 'text' | 'raw';
          state?: { infoObjects: InfoObjectState[] };
          variables?: VariableInput[];
          from_row?: number;
          to_row?: number;
          drill_operations?: DrillOperation[];
        };
        result = await bwQueryData(
          client,
          a.comp_id,
          a.is_provider ?? false,
          a.format ?? 'text',
          a.state,
          a.variables,
          a.from_row ?? 0,
          a.to_row ?? 1000,
          a.drill_operations
        );
        break;
      }

      case 'bw_get_filter_values': {
        const a = args as {
          characteristic_name: string;
          search_string: string;
          info_provider?: string;
          max_rows?: number;
        };
        result = await bwGetFilterValues(
          client,
          a.characteristic_name,
          a.search_string,
          a.info_provider,
          a.max_rows ?? 201
        );
        break;
      }

      case 'bw_get_query': {
        const a = args as { query_name: string };
        result = await bwGetQuery(client, a.query_name);
        break;
      }

      case 'bw_search': {
        const a = args as { search_term: string; object_type?: string };
        result = await bwSearch(client, a.search_term, a.object_type);
        break;
      }

      case 'bw_xref': {
        const a = args as { object_type: string; object_name: string };
        result = await bwXref(client, a.object_type, a.object_name);
        break;
      }

      case 'bw_get_adso': {
        const a = args as { adso_name: string };
        result = await bwGetAdso(client, a.adso_name);
        break;
      }

      case 'bw_get_composite_provider': {
        const a = args as { composite_provider_name: string };
        result = await bwGetCompositeProvider(client, a.composite_provider_name);
        break;
      }

      case 'bw_list_contents': {
        const a = args as { path: string };
        result = await bwListContents(client, a.path);
        break;
      }

      case 'bw_get_dataflow': {
        const a = args as {
          object_name: string;
          object_type: string;
          source_system?: string;
          direction: 'upwards' | 'downwards' | 'both';
          levels: number;
          format?: 'text' | 'raw';
        };
        result = await bwGetDataflow(
          client,
          a.object_name,
          a.object_type,
          a.source_system,
          a.direction,
          a.levels,
          a.format ?? 'text'
        );
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: result }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  try {
    await client.loadMediaTypes();
  } catch (err) {
    process.stderr.write(`[bw4-data-read] Warning: discovery failed (${err})\n`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('bw4-data-read server started\n');
}

main().catch((err) => {
  process.stderr.write(`[bw4-data-read] Fatal: ${err}\n`);
  process.exit(1);
});
