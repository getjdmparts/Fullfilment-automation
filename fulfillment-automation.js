require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const DATABASES = {
  fulfillment_customers: 'd346e7a3-6c1b-821b-afa4-07fae919fb2a',
  orders_fulfillment: '0316e7a3-6c1b-8279-a6da-87778f
