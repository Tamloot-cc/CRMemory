import type { SchemaOperation } from '../schema-engine/operations.js';

/**
 * The three objects every workspace starts with (ARCHITECTURE.md 3.1).
 * Universal IDs are fixed forever: upgrades and templates find these
 * objects and fields by them in every workspace.
 */
export const BASE_OBJECT_IDS = {
  company: '1f24f94d-6bc5-4955-b6ab-ac946e2b140a',
  person: '7e87d873-8c93-4786-9a0b-95447310c8d3',
  task: 'd0690d5f-d7f4-47ce-8007-0a81a276a70b',
} as const;

export const BASE_OPERATIONS: SchemaOperation[] = [
  {
    op: 'create_object',
    object: {
      universalId: BASE_OBJECT_IDS.company,
      nameSingular: 'company',
      namePlural: 'companies',
      labelSingular: 'Company',
      labelPlural: 'Companies',
      description: 'An organization: a customer, prospect, partner or supplier.',
      labelField: 'name',
      fields: [
        {
          universalId: 'ba596fe8-a75f-4a88-9d80-ca22d51d7c72',
          name: 'name',
          label: 'Name',
          type: 'text',
          isSearchable: true,
        },
        {
          universalId: 'bf87f1cd-b6f4-4c93-9ac7-df7a1b6bf641',
          name: 'domain',
          label: 'Domain',
          description: "The company's website. Its domain helps match people to the company.",
          type: 'links',
          isSearchable: true,
        },
        {
          universalId: '4154cec6-8f15-4996-8502-61fd53699980',
          name: 'address',
          label: 'Address',
          type: 'address',
        },
      ],
    },
  },
  {
    op: 'create_object',
    object: {
      universalId: BASE_OBJECT_IDS.person,
      nameSingular: 'person',
      namePlural: 'people',
      labelSingular: 'Person',
      labelPlural: 'People',
      description: 'A person the business works with.',
      labelField: 'name',
      fields: [
        {
          universalId: '5c672ecf-9048-42c2-9213-0a6078980071',
          name: 'name',
          label: 'Name',
          type: 'full_name',
          isSearchable: true,
        },
        {
          universalId: '6eb2edf7-5e1d-48d8-9d61-a701d6c2a37d',
          name: 'emails',
          label: 'Emails',
          description: 'Unique: an email identifies exactly one person.',
          type: 'emails',
          isUnique: true,
          isSearchable: true,
        },
        {
          universalId: 'f285544b-087c-40bc-95df-1e201708794c',
          name: 'phones',
          label: 'Phones',
          description: 'Not unique: numbers are shared and reassigned.',
          type: 'phones',
          isSearchable: true,
        },
        {
          universalId: 'aaea856d-d526-49c7-93b1-4cff91c3862a',
          name: 'address',
          label: 'Address',
          type: 'address',
        },
        {
          universalId: 'bd5ac6d4-9054-462f-8c28-ba9536aa2618',
          name: 'jobTitle',
          label: 'Job title',
          type: 'text',
          isSearchable: true,
        },
        {
          universalId: '42465fa9-9116-480f-b8e4-7905d40d245f',
          name: 'company',
          label: 'Company',
          description: 'Where the person works.',
          type: 'relation',
          settings: { targetObject: BASE_OBJECT_IDS.company, inverseField: 'people' },
        },
      ],
    },
  },
  {
    op: 'create_object',
    object: {
      universalId: BASE_OBJECT_IDS.task,
      nameSingular: 'task',
      namePlural: 'tasks',
      labelSingular: 'Task',
      labelPlural: 'Tasks',
      description: 'Something someone committed to do.',
      labelField: 'title',
      fields: [
        {
          universalId: '5f37aa96-fac8-4572-9647-6b0da5d6d0c8',
          name: 'title',
          label: 'Title',
          type: 'text',
          isSearchable: true,
        },
        {
          universalId: '107158ae-ba0f-482e-afe1-5e45bd6ccfd6',
          name: 'status',
          label: 'Status',
          type: 'select',
          settings: {
            options: [
              { value: 'todo', label: 'To do' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'done', label: 'Done' },
            ],
          },
        },
        {
          universalId: '368276ea-604d-4dcd-b6ad-796431a84a06',
          name: 'dueDate',
          label: 'Due date',
          type: 'date',
        },
        {
          universalId: 'b13c51c0-5902-47f2-9e5f-5582f9f311d1',
          name: 'assignee',
          label: 'Assignee',
          description: 'Who on the team owns the task.',
          type: 'text',
        },
        {
          universalId: '3d66fcfe-2e9c-4aeb-a88a-7d6b3c2194ba',
          name: 'person',
          label: 'Person',
          description: 'The person the task is about.',
          type: 'relation',
          settings: { targetObject: BASE_OBJECT_IDS.person, inverseField: 'tasks' },
        },
        {
          universalId: 'f6b83a8c-c809-4af4-b03a-f4753e10df32',
          name: 'company',
          label: 'Company',
          description: 'The company the task is about.',
          type: 'relation',
          settings: { targetObject: BASE_OBJECT_IDS.company, inverseField: 'tasks' },
        },
      ],
    },
  },
];
