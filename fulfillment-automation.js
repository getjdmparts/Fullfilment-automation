require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const DATABASES = {
  fulfillment_customers: 'd346e7a3-6c1b-821b-afa4-07fae919fb2a',
  orders_fulfillment: '0316e7a3-6c1b-8279-a6da-87778f59f84f',
  quotes_sourcing: '4f76e7a3-6c1b-83cd-8903-077b6e990bb2',
  clients: '65a6e7a3-6c1b-8353-ba92-07d9159fa21f',
  sales: '61d6e7a3-6c1b-8328-bcd0-07dd4d074e3a'
};

const log = (type, msg) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${type}: ${msg}`);
};

async function syncNewCustomers() {
  log('INFO', 'Checking for new customers to sync...');
  try {
    const response = await notion.databases.query({
      database_id: DATABASES.fulfillment_customers,
      filter: {
        property: 'Linked Client',
        relation: { is_empty: true }
      }
    });

    for (const customer of response.results) {
      const customerName = customer.properties.Customer?.title?.[0]?.plain_text || 'Unknown';
      log('ACTION', `Found unlinked customer: ${customerName}`);

      const newClient = await notion.pages.create({
        parent: { database_id: DATABASES.clients },
        properties: {
          Name: { title: [{ text: { content: customerName } }] }
        }
      });

      log('SUCCESS', `Created client for: ${customerName}`);

      await notion.pages.update({
        page_id: customer.id,
        properties: {
          'Linked Client': { relation: [{ id: newClient.id }] }
        }
      });

      log('SUCCESS', `Linked customer ${customerName} to client`);
    }
  } catch (error) {
    log('ERROR', `syncNewCustomers failed: ${error.message}`);
  }
}

async function syncContactInfo() {
  log('INFO', 'Syncing contact information...');
  try {
    const response = await notion.databases.query({
      database_id: DATABASES.fulfillment_customers,
      filter: {
        property: 'Linked Client',
        relation: { is_not_empty: true }
      }
    });

    for (const customer of response.results) {
      const customerName = customer.properties.Customer?.title?.[0]?.plain_text || 'Unknown';
      const linkedClients = customer.properties['Linked Client']?.relation || [];
      if (linkedClients.length === 0) continue;

      const clientId = linkedClients[0].id;
      if (customer.properties.Contact?.email) {
        await notion.pages.update({
          page_id: clientId,
          properties: { Email: { email: customer.properties.Contact.email } }
        });
        log('SYNC', `Updated email for ${customerName}`);
      }
    }
  } catch (error) {
    log('ERROR', `syncContactInfo failed: ${error.message}`);
  }
}

async function linkOrdersToClients() {
  log('INFO', 'Linking orders to clients...');
  try {
    const ordersResponse = await notion.databases.query({
      database_id: DATABASES.orders_fulfillment,
      filter: {
        property: 'Linked Client',
        relation: { is_empty: true }
      }
    });

    for (const order of ordersResponse.results) {
      const customerRelations = order.properties['Customer ']?.relation || [];
      if (customerRelations.length === 0) continue;

      const customerId = customerRelations[0].id;
      const customer = await notion.pages.retrieve({ page_id: customerId });
      const linkedClients = customer.properties['Linked Client']?.relation || [];
      
      if (linkedClients.length > 0) {
        const clientId = linkedClients[0].id;
        await notion.pages.update({
          page_id: order.id,
          properties: { 'Linked Client': { relation: [{ id: clientId }] } }
        });
        log('LINK', `Linked order to client`);
      }
    }
  } catch (error) {
    log('ERROR', `linkOrdersToClients failed: ${error.message}`);
  }
}

async function createSalesFromDeliveredOrders() {
  log('INFO', 'Checking for delivered orders to create sales...');
  try {
    const response = await notion.databases.query({
      database_id: DATABASES.orders_fulfillment,
      filter: {
        property: 'Status',
        select: { equals: 'Delivered' }
      }
    });

    for (const order of response.results) {
      const orderId = order.id;
      const customerName = order.properties.Customer?.title?.[0]?.plain_text || 'Unknown Order';
      const linkedClients = order.properties['Linked Client']?.relation || [];
      const partsOrdered = order.properties['Parts Ordered']?.rich_text?.[0]?.plain_text || 'Parts';

      if (linkedClients.length === 0) {
        log('WARN', `Delivered order has no linked client: ${customerName}`);
        continue;
      }

      const salesResponse = await notion.databases.query({
        database_id: DATABASES.sales,
        filter: {
          property: 'Notes',
          rich_text: { contains: orderId }
        }
      });

      if (salesResponse.results.length > 0) {
        log('INFO', `Sales record already exists for order ${orderId}`);
        continue;
      }

      const newSale = await notion.pages.create({
        parent: { database_id: DATABASES.sales },
        properties: {
          'Sale ID': { title: [{ text: { content: `${customerName} - ${new Date().toLocaleDateString()}` } }] },
          'Item Sold': { rich_text: [{ text: { content: partsOrdered } }] },
          'Clients': { relation: [{ id: linkedClients[0].id }] },
          'Notes': { rich_text: [{ text: { content: `Auto-created from order ${orderId}` } }] },
          'Status': { status: 'Completed' }
        }
      });

      log('SUCCESS', `Created sales record for delivered order: ${customerName}`);
    }
  } catch (error) {
    log('ERROR', `createSalesFromDeliveredOrders failed: ${error.message}`);
  }
}

async function flagOverdueOrders() {
  log('INFO', 'Checking for overdue orders...');
  try {
    const response = await notion.databases.query({
      database_id: DATABASES.orders_fulfillment,
      filter: {
        and: [
          {
            property: 'Status',
            select: { does_not_equal: 'Delivered' }
          },
          {
            property: 'Actual Arrival',
            date: { before: new Date().toISOString().split('T')[0] }
          }
        ]
      }
    });

    for (const order of response.results) {
      const customerName = order.properties.Customer?.title?.[0]?.plain_text || 'Unknown';
      const arrivalDate = order.properties['Actual Arrival']?.date?.start || 'N/A';
      log('ALERT', `OVERDUE ORDER: ${customerName} - Expected: ${arrivalDate}`);
    }

    if (response.results.length > 0) {
      log('ALERT', `Found ${response.results.length} overdue orders needing follow-up`);
    } else {
      log('INFO', 'No overdue orders found');
    }
  } catch (error) {
    log('ERROR', `flagOverdueOrders failed: ${error.message}`);
  }
}

async function runAllAutomations() {
  log('START', '========================================');
  log('START', 'FULFILLMENT AUTOMATION ENGINE STARTING');
  log('START', '========================================');

  try {
    await syncNewCustomers();
    await syncContactInfo();
    await linkOrdersToClients();
    await createSalesFromDeliveredOrders();
    await flagOverdueOrders();

    log('COMPLETE', '========================================');
    log('COMPLETE', 'ALL AUTOMATIONS COMPLETED SUCCESSFULLY');
    log('COMPLETE', '========================================');
  } catch (error) {
    log('CRITICAL', `Automation engine failed: ${error.message}`);
    process.exit(1);
  }
}

runAllAutomations();
