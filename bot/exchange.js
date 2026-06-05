import { config }  from './config.js';
import { Bybit }   from './bybit.js';
import { Toobit }  from './toobit.js';

export const Exchange = config.exchange === 'toobit' ? Toobit : Bybit;
