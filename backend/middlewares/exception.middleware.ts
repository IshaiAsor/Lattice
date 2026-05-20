import { Request, Response, NextFunction } from 'express';


export const exceptionHandler = (req: Request, res: Response, next: NextFunction) => {
    try
    {
        console.log(`Request : ${req}`);
        next();
    }
    catch(err)
    {
        console.error(`Exception cought ${err}`);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
