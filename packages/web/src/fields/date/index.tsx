export { Calendar as icon } from 'lucide-react';
export { FieldDisplay as Display, FieldFilter as Filter, FieldInput as Input } from '../common.js';

import { isEmptyFor } from '../common.js';
export const isEmpty = (value: unknown) => isEmptyFor('date', value);
export const label = 'Date';
