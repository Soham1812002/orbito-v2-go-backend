import path from 'node:path';
import type { Rule } from 'eslint';

const clean = (value: string) => value.replaceAll('\\', '/');

export const architectureRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { boundary: '{{reason}}' },
  },
  create(context) {
    const file = clean(path.relative(context.cwd, context.filename));
    const browser = file.startsWith('services/backend/src/browser/');
    const application = /^services\/(backend|realtime)\/src\//.test(file);
    const shared = file.startsWith('shared/');
    const persistence = file.includes('/database/') || file.endsWith('.repository.ts');
    const composition = /\/(bootstrap|server)\.ts$/.test(file);
    const transport =
      file.includes('/http/') ||
      /\.(routes|controller|middleware)\.ts$/.test(file) ||
      file.endsWith('/app.ts') ||
      file.includes('/sockets/');
    const business =
      application &&
      !browser &&
      !persistence &&
      !composition &&
      !transport &&
      !file.includes('/config/') &&
      !file.includes('/clients/');

    const sharedPure =
      shared &&
      ['/contracts/', '/security/', '/errors/', '/logging/'].some((group) => file.includes(group));

    function violation(value: unknown): string | undefined {
      if (typeof value !== 'string' || !(application || shared)) {
        return;
      }

      if (browser && !value.startsWith('.')) {
        if (value !== 'socket.io-client') {
          return 'Browser modules may import local browser modules and public type contracts only.';
        }

        return;
      }

      if ((business || transport || sharedPure) && value === 'pg') {
        return 'Only persistence and composition code may depend on PostgreSQL.';
      }

      if ((business || sharedPure) && ['express', 'socket.io'].includes(value)) {
        return 'Business services and policies must not depend on HTTP or socket transports.';
      }

      if (!value.startsWith('.')) {
        return;
      }

      const target = clean(
        path.relative(context.cwd, path.resolve(path.dirname(context.filename), value)),
      );

      if (sharedPure && target.includes('/http/')) {
        return 'Pure shared contracts and helpers must not depend on HTTP infrastructure.';
      }

      if (shared && !target.startsWith('shared/')) {
        return 'Shared modules must not depend on either application.';
      }

      if (
        browser &&
        !target.startsWith('services/backend/src/browser/') &&
        target !== 'shared/contracts/console.js'
      ) {
        return 'Browser code cannot import server code or runtime schemas.';
      }

      if (!browser && target.startsWith('services/backend/src/browser/')) {
        return 'Server modules cannot import browser code.';
      }

      if (target.endsWith('/server.js')) {
        return 'Process entry points must not be imported.';
      }

      if (
        application &&
        !composition &&
        !persistence &&
        (target.includes('/database/') ||
          target.endsWith('.repository.js') ||
          target.endsWith('/bootstrap.js'))
      ) {
        return 'Construct persistence dependencies in bootstrap and inject narrow capabilities.';
      }

      if (
        business &&
        (target.includes('/http/') ||
          /\.(routes|controller|middleware)\.js$/.test(target) ||
          target.includes('/sockets/') ||
          target.endsWith('/app.js') ||
          target.includes('/clients/'))
      ) {
        return 'Application logic must depend on capabilities rather than transport implementations.';
      }

      if (persistence && /\.(routes|controller|service)\.js$/.test(target)) {
        return 'Repositories must not import transport or service implementations.';
      }

      if (
        shared &&
        file.includes('/contracts/') &&
        (target.includes('/http/') || target.includes('/security/') || target.includes('/logging/'))
      ) {
        return 'Public contracts must be independent of Node infrastructure.';
      }

      return;
    }

    return {
      ImportDeclaration(node) {
        const reason = violation(node.source.value);

        if (reason) {
          context.report({ node, messageId: 'boundary', data: { reason } });
        }
      },
      ExportNamedDeclaration(node) {
        const reason = violation(node.source?.value);

        if (reason) {
          context.report({ node, messageId: 'boundary', data: { reason } });
        }
      },
      ExportAllDeclaration(node) {
        const reason = violation(node.source.value);

        if (reason) {
          context.report({ node, messageId: 'boundary', data: { reason } });
        }
      },
      CallExpression(node) {
        if (
          (application || shared) &&
          !persistence &&
          !browser &&
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'query'
        ) {
          context.report({
            node,
            messageId: 'boundary',
            data: { reason: 'SQL execution belongs in a repository or database adapter.' },
          });
        }
      },
      MemberExpression(node) {
        if (
          business &&
          node.object.type === 'Identifier' &&
          node.object.name === 'process' &&
          node.property.type === 'Identifier' &&
          node.property.name === 'env'
        ) {
          context.report({
            node,
            messageId: 'boundary',
            data: {
              reason: 'Read environment variables in configuration and inject explicit options.',
            },
          });
        }
      },
    };
  },
};
